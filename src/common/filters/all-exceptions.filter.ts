import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Prisma } from '@prisma/client';

/**
 * Rótulos PT-BR para campos com unique constraint — usados na mensagem do P2002.
 * Campos fora do mapa caem no nome cru (ainda amigável: "Valor já cadastrado para X").
 */
const UNIQUE_FIELD_LABELS: Record<string, string> = {
  document: 'documento (CPF/CNPJ)',
  documentNumberClean: 'documento (CPF/CNPJ)',
  documentNumber: 'documento (CPF/CNPJ)',
  email: 'e-mail',
  slug: 'slug',
  code: 'código',
  phone: 'telefone',
  name: 'nome',
};

/**
 * Campos cujo valor é um documento (CPF ou CNPJ no mesmo campo). Mapeia o nome do
 * campo do unique constraint para os possíveis nomes no body da request, pra inferir
 * o rótulo PRECISO ("CNPJ"/"CPF") a partir do número enviado. Sem isso, todo conflito
 * de documento vira o genérico "documento (CPF/CNPJ)".
 */
const DOCUMENT_FIELD_BODY_KEYS: Record<string, string[]> = {
  document: ['document'],
  documentNumberClean: ['documentNumberClean', 'documentNumber'],
  documentNumber: ['documentNumber', 'documentNumberClean'],
};

/**
 * Rótulo preciso de um documento a partir do valor cru: 14 dígitos → CNPJ,
 * 11 → CPF. Qualquer outro tamanho (ou valor ausente) cai no genérico, evitando
 * afirmar o tipo errado.
 */
function documentLabelFromValue(raw: unknown): string {
  const digits = typeof raw === 'string' || typeof raw === 'number' ? String(raw).replace(/\D/g, '') : '';
  if (digits.length === 14) return 'CNPJ';
  if (digits.length === 11) return 'CPF';
  return UNIQUE_FIELD_LABELS.document;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  /**
   * Mapeia erros CONHECIDOS do Prisma para respostas HTTP amigáveis.
   * Sem isso, um P2002 (unique) que escapou das validações dos services virava
   * 500 com a mensagem CRUA do Prisma (paths de arquivo, trecho de código) no
   * body — vazamento de detalhe interno + UX horrível pro front.
   */
  private mapPrismaError(
    e: Prisma.PrismaClientKnownRequestError,
    body?: any,
  ): { status: HttpStatus; message: string; code: string } | null {
    switch (e.code) {
      case 'P2002': {
        // meta.target: string[] (campos) ou string (nome do índice), conforme o caso.
        const target = e.meta?.target;
        const fields = Array.isArray(target) ? target.map(String) : target ? [String(target)] : [];
        const labels = fields.map((f) => {
          // Campo de documento: tenta inferir CPF vs CNPJ pelo valor enviado.
          const bodyKeys = DOCUMENT_FIELD_BODY_KEYS[f];
          if (bodyKeys && body && typeof body === 'object') {
            const value = bodyKeys.map((k) => body[k]).find((v) => v != null);
            if (value != null) return documentLabelFromValue(value);
          }
          return UNIQUE_FIELD_LABELS[f] ?? f;
        });
        const fieldsTxt = labels.length ? ` para: ${labels.join(', ')}` : '';
        return {
          status: HttpStatus.CONFLICT,
          message: `Valor já cadastrado${fieldsTxt}. Verifique os dados e tente novamente.`,
          code: 'DUPLICATE_VALUE',
        };
      }
      case 'P2025': // registro exigido pela operação não existe (update/delete)
        return {
          status: HttpStatus.NOT_FOUND,
          message: 'Registro não encontrado.',
          code: 'RECORD_NOT_FOUND',
        };
      case 'P2003': // violação de chave estrangeira
        return {
          status: HttpStatus.CONFLICT,
          message: 'Operação não permitida: existem registros vinculados a este item.',
          code: 'RELATED_RECORDS_EXIST',
        };
      default:
        return null; // demais códigos: 500 genérico (sem vazar detalhe)
    }
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.httpAdapterHost;
    const ctx = host.switchToHttp();
    const request = ctx.getRequest();
    const response = ctx.getResponse();

    // Ignorar erros de autenticação JWT no callback do Google (o GoogleAuthGuard já trata)
    // Esses erros são esperados porque o Passport tenta JWT antes do Google
    const url = request.url || httpAdapter.getRequestUrl(request);
    if (
      (url?.includes('/auth/google/callback') ||
        url?.includes('/api/v1/auth/google/callback')) &&
      exception instanceof HttpException &&
      exception.getStatus() === HttpStatus.UNAUTHORIZED
    ) {
      if (response.headersSent || response.finished) return;
      response.redirect('/login?error=auth_failed');
      return;
    }

    let httpStatus = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let errors: any = undefined;
    // Código de erro TIPADO (ex.: VOUCHER_ALREADY_USED) — exceções de domínio
    // lançam `{ code, message }`; sem o passthrough o front só recebe a message
    // e não consegue ramificar por tipo de erro.
    let code: string | undefined;

    if (exception instanceof HttpException) {
      httpStatus = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      // Se a resposta é um objeto com mensagem
      if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
        const responseObj = exceptionResponse as any;

        // Capturar mensagem principal
        if (responseObj.message) {
          if (Array.isArray(responseObj.message)) {
            // Erros de validação do class-validator
            message = responseObj.message[0] || 'Validation failed';
            errors = responseObj.message;
          } else {
            message = responseObj.message;
          }
        } else {
          message = exception.message || 'Bad Request';
        }

        // Capturar código tipado se existir (`{ code, message }` das exceções de domínio)
        if (typeof responseObj.code === 'string' && responseObj.code) {
          code = responseObj.code;
        }

        // Capturar erros adicionais se existirem (details do ValidationPipe customizado)
        if (responseObj.errors) {
          errors = responseObj.errors;
        }

        // Capturar detalhes se existirem
        if (responseObj.details) {
          errors = responseObj.details;
        }
      } else if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else {
        message = exception.message || 'Bad Request';
      }
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      // Erro CONHECIDO do Prisma (P2002 unique, P2025 not found, P2003 FK...).
      const mapped = this.mapPrismaError(exception, request?.body);
      if (mapped) {
        httpStatus = mapped.status;
        message = mapped.message;
        code = mapped.code;
        // Warn (não error): é falha de negócio esperada, não bug — mas logamos o
        // detalhe original pra rastrear de onde escapou (idealmente o service
        // valida antes e este caminho é só a rede de segurança da race).
        this.logger.warn(
          `Prisma ${exception.code} mapeado para ${httpStatus}: ${exception.message.split('\n').pop()}`,
        );
      } else {
        this.logger.error(`Prisma error ${exception.code}: ${exception.message}`, exception.stack);
        message = 'Erro interno do servidor';
      }
    } else if (exception instanceof Prisma.PrismaClientValidationError) {
      // Query malformada (geralmente bug nosso) — mensagem crua expõe schema/código.
      this.logger.error(`Prisma validation error: ${exception.message}`, exception.stack);
      message = 'Erro interno do servidor';
    } else if (exception instanceof Error) {
      // NUNCA vazar a mensagem crua de erro não-HTTP em produção (pode conter
      // paths, SQL, detalhes de infra). Em development mantemos pra DX.
      message =
        process.env.NODE_ENV === 'development'
          ? exception.message
          : 'Erro interno do servidor';
      this.logger.error(
        `Unhandled exception: ${exception.message}`,
        exception.stack,
      );
    }

    // Nível do log POR STATUS: só 5xx (bug/infra real) sai como ERROR + stack. Os
    // 4xx são esperados (validação, auth, e — sobretudo — 404 de rota inexistente
    // que SCANNERS de vulnerabilidade disparam às dezenas: POST /sigin, /wp-login,
    // /_next/…) → WARN de UMA linha, SEM stack, pra não afogar o log e esconder erro
    // de verdade. Um stack trace por probe de bot era puro ruído.
    const requestUrl = httpAdapter.getRequestUrl(request);
    const requestMethod = request.method;

    if (httpStatus >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `Exception: ${message} on ${requestMethod} ${requestUrl}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else if (httpStatus === HttpStatus.BAD_REQUEST && errors) {
      // Validação: WARN com o detalhe (útil p/ diagnosticar o cliente), sem stack.
      this.logger.warn(
        `Validation failed on ${requestMethod} ${requestUrl}: ${JSON.stringify(errors)}`,
      );
    } else {
      this.logger.warn(`${httpStatus} ${message} on ${requestMethod} ${requestUrl}`);
    }

    const responseBody: any = {
      statusCode: httpStatus,
      timestamp: new Date().toISOString(),
      path: httpAdapter.getRequestUrl(request),
      message,
    };

    // Campo aditivo — clientes que só leem `message` não são afetados
    if (code) {
      responseBody.code = code;
    }

    // Adicionar erros de validação se existirem
    if (errors) {
      responseBody.errors = errors;
    }

    // Adicionar detalhes adicionais em desenvolvimento
    if (process.env.NODE_ENV === 'development' && exception instanceof Error) {
      responseBody.stack = exception.stack;
    }

    // Verificar se a resposta já foi enviada (ex: redirect)
    if (response.headersSent || response.finished) {
      this.logger.warn(
        `Cannot send error response: headers already sent for ${request.url}`,
      );
      return;
    }

    httpAdapter.reply(response, responseBody, httpStatus);
  }
}
