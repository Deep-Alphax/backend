import { ValidationPipe, BadRequestException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { join } from 'path';
import { useContainer } from 'class-validator';
import helmet from 'helmet';
import { SecurityHeadersInterceptor } from './common/interceptors/security-headers.interceptor';
import { ConcurrencyLimiterMiddleware } from './common/middleware/concurrency-limiter.middleware';
import { HttpAdapterHost } from '@nestjs/core';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import compression from 'compression';
import passport from 'passport';
import session from 'express-session';
import express, { type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import { initializeSentry } from './config/sentry.config';
import { isTrustedOrigin } from './common/config/allowed-origins';

type RequestWithRawBody = Request & { rawBody?: Buffer };

initializeSentry();

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });

  // Confia em 1 hop de proxy (nginx/Caddy no mesmo host à frente do Node). Com isso o Express
  // resolve `req.ip` (e `req.protocol`/`secure`) a partir do PRIMEIRO IP do X-Forwarded-For —
  // ou seja, o IP REAL do cliente, não o do proxy. Sem isso, todo rate-limit/log/antifraude
  // baseado em IP colapsava todos os clientes no IP do proxy (um balde global). `1` (e NÃO
  // `true`) é deliberado: confiar cegamente no XFF de qualquer origem deixaria o cliente forjar
  // o header e furar os limites por IP. Se a topologia mudar (ex.: CDN + LB), ajustar os hops.
  app.set('trust proxy', 1);

  app.use(
    express.json({
      limit: '200mb',
      verify: (req: RequestWithRawBody, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );
  app.use(express.urlencoded({ limit: '200mb', extended: true }));

  const configService = app.get(ConfigService);
  const httpAdapterHost = app.get(HttpAdapterHost);
  app.useGlobalFilters(new AllExceptionsFilter(httpAdapterHost));

  app.use(compression());
  app.use(cookieParser());

  const sessionSecret = configService.get<string>('SESSION_SECRET');
  if (!sessionSecret && process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET é obrigatório em produção');
  }

  app.use(
    session({
      secret: sessionSecret || 'dev-secret-insecure',
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: configService.get<string>('NODE_ENV') === 'production',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000,
        sameSite: 'strict',
      },
    }),
  );
  app.use(passport.initialize());
  app.use(passport.session());

  const isDev = process.env.NODE_ENV === 'development';
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'https:', 'http:'],
          connectSrc: ["'self'", 'https:', 'wss:'],
        },
      },
      crossOriginEmbedderPolicy: false,
      crossOriginOpenerPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      // HSTS só em prod (https). Em dev (http) o browser ignora; ligar atrapalha.
      // Fonte ÚNICA dos security headers agora é o helmet — não há mais middleware
      // manual setando HSTS/nosniff/referrer (removido com a consolidação do CORS).
      hsts: isDev ? false : { maxAge: 31536000, includeSubDomains: true },
    }),
  );

  app.enableCors({
    // Origem confiável = allowlist (+ localhost só em dev LOCAL), NÃO "qualquer
    // origem quando isDev". Antes, rodar como development (caso do homolog) refletia
    // QUALQUER Origin com credentials → qualquer site lia dados do usuário logado.
    // `isTrustedOrigin` fecha isso mesmo em development. Sem Origin (server-to-server,
    // webhook da Cielo, same-origin) continua liberado.
    origin: (origin, callback) => {
      if (!origin || isTrustedOrigin(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'x-api-bypass',
      'x-csrf-token',
      'Origin',
      'Accept',
      'X-Requested-With',
      'Idempotency-Key',
      // Telemetria de atividade (UserActivityLog) — sem ele o preflight do
      // browser bloqueia TODA request do front (que envia o header sempre)
      'x-session-id',
      // Superfície de sessão (admin/organizer/client) — idem: o front envia em
      // toda request; sem o allow-header o preflight cross-origin bloquearia tudo.
      'x-pt-surface',
    ],
    // Sem isso, o JS do front NÃO consegue ler Content-Disposition em respostas
    // cross-origin → todo download por blob (CSV/XLSX/PDF de export) cai no
    // filename de fallback e baixa com extensão errada (ex.: CSV virava .txt).
    exposedHeaders: ['Content-Disposition'],
    credentials: true,
    preflightContinue: false,
    optionsSuccessStatus: 204,
  });

  if (isDev) {
    const config = new DocumentBuilder()
      .setTitle('Deep Alpha API')
      .setDescription(`API documentation for Deep Alpha — Wallet Analytics`)
      .setVersion('1.0')
      .addBearerAuth()
      .addServer('http://localhost:3333')
      .build();

    const document = SwaggerModule.createDocument(app, config);
    const swaggerOptions = {
      swaggerOptions: {
        persistAuthorization: true,
        displayRequestDuration: true,
        docExpansion: 'none',
        filter: false,
        showExtensions: true,
        showCommonExtensions: true,
        requestInterceptor: (req) => {
          req.withCredentials = true;
          return req;
        },
        responseInterceptor: (res) => {
          return res;
        },
      },
      customSiteTitle: 'Deep Alpha API Docs',
    };

    SwaggerModule.setup('api', app, document, swaggerOptions);
  }

  const concurrencyLimiter = new ConcurrencyLimiterMiddleware();
  app.use(concurrencyLimiter.use.bind(concurrencyLimiter));

  const uploadsPath = join(process.cwd(), 'uploads');
  app.use(
    '/uploads',
    express.static(uploadsPath, {
      maxAge: '30d',
      etag: true,
      lastModified: true,
    }),
  );

  useContainer(app.select(AppModule), { fallbackOnErrors: true });

  // Campos cujo valor NUNCA pode voltar no corpo do erro nem nos logs: senhas,
  // tokens, segredos, documentos. Sem isto, uma falha de validação (ex.: senha
  // curta) ecoava a própria senha submetida na resposta 400 e no log.
  const SENSITIVE_FIELDS = new Set([
    'password',
    'currentPassword',
    'newPassword',
    'confirmPassword',
    'oldPassword',
    'token',
    'refreshToken',
    'refresh_token',
    'accessToken',
    'access_token',
    'mfaToken',
    'code',
    'totpSecret',
    'turnstileToken',
    'cpf',
    'documentNumber',
  ]);
  const redactValue = (property: string, value: any): any =>
    SENSITIVE_FIELDS.has(property) ? '[REDACTED]' : value;
  const validationExceptionFactory = (errors: any[]) => {
    const formatError = (error: any): any => {
      const constraints = error.constraints || {};
      const messages = Object.values(constraints);
      const formatted: any = {
        property: error.property,
        value: redactValue(error.property, error.value),
        message:
          messages[0] || `Validation failed for property ${error.property}`,
        constraints: constraints,
      };
      if (error.children && error.children.length > 0) {
        formatted.children = error.children.map((child: any) => formatError(child));
      }
      return formatted;
    };
    const formattedErrors = errors.map(formatError);
    return new BadRequestException({
      message: 'Validation failed',
      errors: formattedErrors.map((e) => e.message),
      details: formattedErrors,
    });
  };

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      forbidNonWhitelisted: true,
      whitelist: true,
      forbidUnknownValues: true,
      exceptionFactory: validationExceptionFactory,
    }),
  );

  app.useGlobalInterceptors(new SecurityHeadersInterceptor());

  const httpAdapter = app.getHttpAdapter();
  httpAdapter.get('/health', (req: Request, res: Response) => {
    res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      instance: process.env.INSTANCE_ID || 'default',
    });
  });

  const port = Number(process.env.PORT) || 3333;
  await app.listen(port, '0.0.0.0');
}

bootstrap();
