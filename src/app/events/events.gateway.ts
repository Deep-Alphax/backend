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
import type { CapturedMessage } from '@prisma/client';
import { isTrustedOrigin } from '../../common/config/allowed-origins';
import {
  WALLET_SYNC_STATE_EVENT,
  WalletSyncStateEvent,
} from '../analytics/ingestion/wallet-sync.service';
import { FEED_CAPTURED_EVENT } from '../feed/feed.service';
import { FeedAccessService } from '../feed/feed-access.service';
import { EntitlementsService } from '../billing/entitlements.service';
import {
  NOTIFICATION_CREATED_EVENT,
  type NotificationCreatedEvent,
} from '../alerts/alert-dispatch.service';
import {
  PLAN_CHANGED_EVENT,
  type PlanChangedEvent,
} from '../billing/plan-events';
import {
  WALLET_SCAN_STATE_EVENT,
  type WalletScanStateEvent,
} from '../wallet-reader/wallet-reader.service';

/** Superfícies de sessão válidas (cada uma tem seu cookie `pt_at_<surface>`). */
const ALLOWED_SURFACES = new Set(['client', 'admin', 'organizer']);

const userRoom = (userId: string): string => `user:${userId}`;
/**
 * Salas do feed do radar, uma por plano. PRO recebe toda captura; FREE só as
 * dos grupos liberados (`FeedAccessService`) — mesma regra do GET /feed/messages.
 * Sala por plano (e não filtro por socket) mantém o emit O(1) por captura.
 */
const FEED_PRO_ROOM = 'feed:pro';
const FEED_FREE_ROOM = 'feed:free';

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
    ) =>
      !origin || isTrustedOrigin(origin)
        ? cb(null, true)
        : cb(new Error('Not allowed by CORS')),
    credentials: true,
  },
})
export class EventsGateway implements OnGatewayConnection {
  private readonly logger = new Logger(EventsGateway.name);

  @WebSocketServer() private server!: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly entitlements: EntitlementsService,
    private readonly feedAccess: FeedAccessService,
  ) {}

  private async feedRoomFor(userId: string): Promise<string> {
    return (await this.entitlements.isPro(userId))
      ? FEED_PRO_ROOM
      : FEED_FREE_ROOM;
  }

  async handleConnection(client: Socket): Promise<void> {
    try {
      const token = tokenFromHandshake(client);
      if (!token) return void client.disconnect();

      const payload = await this.jwt.verifyAsync<{
        sub?: string;
        mfaPending?: boolean;
      }>(token, {
        secret: this.config.get<string>('JWT_SECRET'),
        algorithms: ['HS256'],
      });
      // Token de challenge MFA não abre canal — mesma regra da JwtStrategy.
      if (!payload?.sub || payload.mfaPending) return void client.disconnect();

      await client.join(userRoom(payload.sub));

      // Sala do feed conforme o plano. Mudança de plano com o socket aberto é
      // tratada em `handlePlanChanged`, sem exigir reconexão.
      await client.join(await this.feedRoomFor(payload.sub));
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

  /**
   * Nova captura do Discord → PRO sempre; FREE só se o grupo for liberado.
   * Captura sem monitor não é gratuita (fail-closed, igual ao REST).
   */
  @OnEvent(FEED_CAPTURED_EVENT)
  async handleFeedCaptured(message: CapturedMessage): Promise<void> {
    // Listener async: rejeição solta aqui derrubaria o processo. Se a consulta
    // dos grupos liberados falhar, o PRO ainda recebe (fail-closed para o FREE).
    let isFree = false;
    try {
      isFree =
        message.monitorId !== null &&
        (await this.feedAccess.freeMonitorIds()).includes(message.monitorId);
    } catch (err) {
      this.logger.warn(`Recorte FREE indisponível: ${(err as Error).message}`);
    }
    // `to(a).to(b)` entrega UMA vez por socket, mesmo em duas salas.
    const target = isFree
      ? this.server.to(FEED_PRO_ROOM).to(FEED_FREE_ROOM)
      : this.server.to(FEED_PRO_ROOM);
    target.emit('feed:new', message);
  }

  /**
   * Varredura terminou → só PRO. O resultado traz carteiras de KOL, que o FREE
   * não vê (nem pelo REST — o controller de scans é PRO).
   */
  @OnEvent(WALLET_SCAN_STATE_EVENT)
  handleWalletScanState(payload: WalletScanStateEvent): void {
    this.server.to(FEED_PRO_ROOM).emit('scan:update', payload.result);
  }

  /** Alerta disparou → sininho do dono atualiza na hora (sem polling). */
  @OnEvent(NOTIFICATION_CREATED_EVENT)
  handleNotificationCreated({
    userId,
    notification,
  }: NotificationCreatedEvent): void {
    this.server.to(userRoom(userId)).emit('notification:new', notification);
  }

  /**
   * Assinatura mudou → move as conexões abertas do usuário para a sala certa e
   * avisa o front (`plan:update`) para refazer as queries que dependem do plano.
   */
  @OnEvent(PLAN_CHANGED_EVENT)
  async handlePlanChanged({ userId }: PlanChangedEvent): Promise<void> {
    try {
      const room = await this.feedRoomFor(userId);
      const sockets = this.server.in(userRoom(userId));
      sockets.socketsLeave([FEED_PRO_ROOM, FEED_FREE_ROOM]);
      sockets.socketsJoin(room);
      this.server.to(userRoom(userId)).emit('plan:update', {
        plan: room === FEED_PRO_ROOM ? 'PRO' : 'FREE',
      });
    } catch (err) {
      // Sem troca de sala o usuário só fica na sala antiga até reconectar.
      this.logger.warn(
        `Troca de sala por plano falhou: ${(err as Error).message}`,
      );
    }
  }
}
