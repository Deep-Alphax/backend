import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  StreamableFile,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

@Injectable()
export class ResponseCompressionInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(
      map((data) => {
        if (data instanceof StreamableFile) return data;

        // Primeiro transformar as datas
        const transformedData = this.transformDates(data);

        if (Array.isArray(transformedData) && transformedData.length > 0) {
          const optimizedData = this.optimizeArrayResponse(transformedData);
          return optimizedData;
        }
        if (typeof transformedData === 'object' && transformedData !== null) {
          return this.removeEmptyFields(transformedData);
        }
        return transformedData;
      }),
    );
  }

  private optimizeArrayResponse(data: any[]): any {
    if (data.length > 100) {
      return {
        data: data.slice(0, 50),
        hasMore: true,
        total: data.length,
        message:
          'Response truncated for performance. Use pagination parameters.',
      };
    }
    return data.map((item) => this.removeEmptyFields(item));
  }

  private removeEmptyFields(obj: any): any {
    if (Array.isArray(obj)) {
      return obj.map((item) => this.removeEmptyFields(item));
    }

    if (typeof obj === 'object' && obj !== null) {
      // Não remover campos de data mesmo se estiverem vazios
      if (this.isDateField(obj)) {
        return obj;
      }

      const cleaned: any = {};
      for (const [key, value] of Object.entries(obj)) {
        // Manter campos de data sempre, mesmo se vazios
        if (
          key === 'createdAt' ||
          key === 'updatedAt' ||
          key === 'created_at' ||
          key === 'updated_at'
        ) {
          cleaned[key] = this.removeEmptyFields(value);
        } else if (value !== null && value !== undefined && value !== '') {
          // Para outros campos, verificar se não são objetos vazios
          if (
            typeof value === 'object' &&
            value !== null &&
            !Array.isArray(value)
          ) {
            const cleanedValue = this.removeEmptyFields(value);
            // Só adicionar se o objeto não ficou vazio ou se é um campo especial
            if (
              Object.keys(cleanedValue).length > 0 ||
              this.isDateField(value)
            ) {
              cleaned[key] = cleanedValue;
            }
          } else {
            cleaned[key] = this.removeEmptyFields(value);
          }
        }
      }
      return cleaned;
    }

    return obj;
  }

  private transformDates(obj: any): any {
    if (obj instanceof Date) {
      return obj.toISOString();
    }

    if (Array.isArray(obj)) {
      return obj.map((item) => this.transformDates(item));
    }

    if (typeof obj === 'object' && obj !== null) {
      const transformed: any = {};

      for (const [key, value] of Object.entries(obj)) {
        // Transformar campos de data específicos
        if (
          (key === 'createdAt' ||
            key === 'updatedAt' ||
            key === 'created_at' ||
            key === 'updated_at') &&
          value
        ) {
          if (value instanceof Date) {
            transformed[key] = value.toISOString();
          } else if (typeof value === 'object' && value !== null) {
            // Se for um objeto de data do Prisma, tentar extrair
            transformed[key] = this.extractDateFromPrismaObject(value);
          } else {
            transformed[key] = value;
          }
        } else {
          transformed[key] = this.transformDates(value);
        }
      }

      return transformed;
    }

    return obj;
  }

  private extractDateFromPrismaObject(obj: any): string | any {
    // Tentar diferentes formatos que o Prisma pode retornar
    if (obj.$date) {
      return new Date(obj.$date).toISOString();
    }
    if (obj.toISOString) {
      return obj.toISOString();
    }
    if (typeof obj === 'string') {
      // Se já for uma string ISO, manter como está
      return obj;
    }
    // Se for um objeto vazio, pode ser uma data não serializada corretamente
    if (Object.keys(obj).length === 0) {
      return new Date().toISOString(); // Fallback para data atual
    }

    return obj;
  }

  private isDateField(obj: any): boolean {
    // Verificar se é um objeto de data (geralmente tem propriedades específicas)
    return (
      typeof obj === 'object' &&
      obj !== null &&
      (obj.hasOwnProperty('$date') ||
        obj.hasOwnProperty('toISOString') ||
        Object.keys(obj).length === 0)
    ); // Objeto vazio pode ser uma data
  }
}
