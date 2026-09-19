import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PrismaModule } from '../../prisma/prisma.module';
import { FeedController } from './feed.controller';
import { MonitorsController } from './monitors.controller';
import { BlacklistController } from './blacklist.controller';
import {
  FavoritesController,
  FavoritePhotoController,
} from './favorites.controller';
import { FeedService } from './feed.service';
import { MonitorsService } from './monitors.service';
import { BlacklistService } from './blacklist.service';
import { FavoritesService } from './favorites.service';
import { TelegramService } from './telegram.service';
import { DiscordMonitorService } from './discord-monitor.service';
import { FeedAccessService } from './feed-access.service';
import { EntitlementsModule } from '../billing/entitlements.module';

/**
 * Feed do Discord: self-bot que captura mensagens de canais monitorados (CRUD de
 * regras pelo admin), persiste no Postgres e empurra ao Telegram. Endpoints sob JWT
 * (leitura) e JWT+Admin (gestão). O self-bot é inerte sem `DISCORD_USER_TOKEN`.
 */
@Module({
  imports: [PrismaModule, HttpModule, EntitlementsModule],
  controllers: [
    FeedController,
    MonitorsController,
    BlacklistController,
    FavoritesController,
    FavoritePhotoController,
  ],
  providers: [
    FeedService,
    MonitorsService,
    BlacklistService,
    FavoritesService,
    TelegramService,
    DiscordMonitorService,
    FeedAccessService,
  ],
  // O gateway de tempo real e os alertas aplicam o MESMO recorte por plano.
  exports: [FeedAccessService],
})
export class FeedModule {}
