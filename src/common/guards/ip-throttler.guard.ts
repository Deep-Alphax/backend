import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { getClientIp } from '../utils/client-ip.util';

/**
 * ThrottlerGuard que identifica o cliente pelo IP REAL (via `getClientIp`, que prioriza
 * `x-forwarded-for`) em vez do `req.ip` padrão.
 *
 * Por quê: atrás de um proxy/load balancer, o `req.ip` padrão do throttler seria o IP do
 * PROXY — igual para todos os clientes —, colapsando o site inteiro num único balde de
 * rate-limit (o limite vira um teto GLOBAL). Isso é "cinto-e-suspensório" com o
 * `app.set('trust proxy', 1)` do bootstrap: mesmo que o trust proxy seja reconfigurado
 * errado um dia, o tracker ainda usa o XFF. Cai pra `req.ip` se não houver XFF.
 */
@Injectable()
export class IpThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    return getClientIp(req as any) || req.ip;
  }
}
