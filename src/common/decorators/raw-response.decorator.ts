import { SetMetadata } from '@nestjs/common';

export const RAW_RESPONSE = 'rawResponse';

/**
 * Entrega a resposta do handler INTACTA, sem passar pelo
 * `ResponseCompressionInterceptor`.
 *
 * Use quando o corpo tem semântica de vazio ou tamanho próprio: o interceptor
 * remove campos `null`/`undefined`/`""` e trunca arrays com mais de 100 itens
 * (embrulhando em `{ data, hasMore, total }`). Para um DTO em que `null` quer
 * dizer "herda" e `""` quer dizer "o usuário limpou", isso apaga informação.
 */
export const RawResponse = () => SetMetadata(RAW_RESPONSE, true);
