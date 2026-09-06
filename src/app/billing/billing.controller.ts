import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { BillingService } from './billing.service';
import { EntitlementsService } from './entitlements.service';

type RequestWithRawBody = Request & { rawBody?: Buffer };

@Controller('api/v1/billing')
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly entitlements: EntitlementsService,
  ) {}

  /** Plano efetivo do usuário logado — o front usa para marcar o card atual. */
  @UseGuards(JwtAuthGuard)
  @Get('me')
  async me(@Req() req: Request & { user: { id: string } }) {
    return { plan: await this.entitlements.planFor(req.user.id) };
  }

  /** Abre o Checkout de assinatura e devolve a URL para redirecionar. */
  @UseGuards(JwtAuthGuard)
  @Post('checkout')
  async checkout(@Req() req: Request & { user: { id: string } }) {
    return this.billing.createCheckoutSession(req.user.id);
  }

  /**
   * Webhook do Stripe.
   *
   * SEM guard de autenticação de propósito: o Stripe não manda cookie nem JWT.
   * Quem autentica é a assinatura em `stripe-signature`, conferida contra o
   * `STRIPE_WEBHOOK_SECRET` — é isso que prova a origem.
   *
   * `@SkipThrottle()`: o `IpThrottlerGuard` é global e o Stripe faz retry com
   * backoff, podendo rajar num incidente. Tomar 429 faria ele desistir e a
   * assinatura ficaria dessincronizada. A proteção desta rota é a assinatura,
   * não o rate-limit por IP.
   *
   * O `RequestOriginGuard` (CSRF) não precisa de exceção: ele libera quando não
   * há `Origin`/`Referer`, que é o caso de chamada server-to-server.
   *
   * Responde 2xx rápido: qualquer trabalho pesado deve sair do request, senão o
   * Stripe considera falha e reentrega.
   */
  @SkipThrottle()
  @Post('webhook/stripe')
  async webhook(
    @Req() req: RequestWithRawBody,
    @Headers('stripe-signature') signature: string,
    @Body() _body: unknown,
  ) {
    if (!signature) throw new BadRequestException('stripe-signature ausente.');
    const event = this.billing.constructEvent(req.rawBody, signature);
    const { handled } = await this.billing.handleEvent(event);
    return { received: true, handled };
  }
}
