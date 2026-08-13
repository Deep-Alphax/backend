import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { OnEvent } from '@nestjs/event-emitter';
import {
  OnGatewayConnection,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { isTrustedOrigin } from '../../common/config/allowed-origins';
import {
  WALLET_SYNC_STATE_EVENT,
  WalletSyncStateEvent,
} from '../analytics/ingestion/wallet-sync.service';

/** Superfícies de sessão válidas (cada uma tem seu cookie `pt_at_<surface>`). */
const ALLOWED_SURFACES = new Set(['client', 'admin', 'organizer']);

const userRoom = (userId: string): string => `user:${userId}`;

/**
 * Extrai o token de acesso do cookie do handshake. A superfície vem do header
 * `x-pt-surface` (enviado no handshake de polling); default `client` (a do front).
 * Sem lib externa: parse manual do header `cookie`.
 */
function tokenFromHandshake(client: Socket): string | null {
  const raw = client.handshake.headers.cookie;
  if (!raw) return null;

  const surfaceHeader = client.handshake.headers['x-pt-surface'];
  const surface =
    typeof surfaceHeader === 'string' && ALLOWED_SURFACES.has(surfaceHeader)
      ? surfaceHeader
      : 'client';
  const cookieName = `pt_at_${surface}`;

  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== cookieName) continue;
    const value = decodeURIComponent(part.slice(eq + 1).trim());
    return value && value !== 'undefined' && value !== 'null' ? value : null;
  }
  return null;
}

/**
 * Canal WebSocket de tempo real. Autentica o socket pelo MESMO cookie httpOnly de
 * sessão (JWT HS256), coloca o cliente numa sala privada `user:<id>` e empurra os
 * eventos do backend (ex.: fim de sync de carteira) só para o dono. Substitui o
 * polling do front: o dashboard reage à ingestão em tempo real.
 *
 * CORS espelha o do HTTP (`isTrustedOrigin` + credentials) — sem isso o browser
 * não anexa o cookie e o handshake cross-origin é barrado.
 */
@WebSocketGateway({
  cors: {
    origin: (
      origin: string | undefined,
      cb: (err: Error | null, allow?: boolean) => void,
    ) => (!origin || isTrustedOrigin(origin) ? cb(null, true) : cb(new Error('Not allowed by CORS'))),
    credentials: true,
  },
})
export class EventsGateway implements OnGatewayConnection {
  private readonly logger = new Logger(EventsGateway.name);

  @WebSocketServer() private server!: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    try {
      const token = tokenFromHandshake(client);
      if (!token) return void client.disconnect();

      const payload = await this.jwt.verifyAsync<{ sub?: string; mfaPending?: boolean }>(
        token,
        { secret: this.config.get<string>('JWT_SECRET'), algorithms: ['HS256'] },
      );
      // Token de challenge MFA não abre canal — mesma regra da JwtStrategy.
      if (!payload?.sub || payload.mfaPending) return void client.disconnect();

      await client.join(userRoom(payload.sub));
    } catch {
      // Assinatura/exp inválida → sem canal (silencioso; é ruído esperado).
      client.disconnect();
    }
  }

  /** Fim do sync de uma carteira OWN → notifica só o dono para refazer as queries. */
  @OnEvent(WALLET_SYNC_STATE_EVENT)
  handleWalletSyncState(payload: WalletSyncStateEvent): void {
    this.server.to(userRoom(payload.userId)).emit('sync:update', {
      walletId: payload.walletId,
      status: payload.status,
      inserted: payload.inserted,
    });
  }
}
