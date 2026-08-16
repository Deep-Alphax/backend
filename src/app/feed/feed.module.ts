import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PrismaModule } from '../../prisma/prisma.module';
import { FeedController } from './feed.controller';
import { MonitorsController } from './monitors.controller';
import { BlacklistController } from './blacklist.controller';
import { FavoritesController } from './favorites.controller';
import { FeedService } from './feed.service';
import { MonitorsService } from './monitors.service';
import { BlacklistService } from './blacklist.service';
import { FavoritesService } from './favorites.service';
import { TelegramService } from './telegram.service';
import { DiscordMonitorService } from './discord-monitor.service';

/**
 * Feed do Discord: self-bot que captura mensagens de canais monitorados (CRUD de
 * regras pelo admin), persiste no Postgres e empurra ao Telegram. Endpoints sob JWT
 * (leitura) e JWT+Admin (gestão). O self-bot é inerte sem `DISCORD_USER_TOKEN`.
 */
@Module({
  imports: [PrismaModule, HttpModule],
  controllers: [
    FeedController,
    MonitorsController,
    BlacklistController,
    FavoritesController,
  ],
  providers: [
    FeedService,
    MonitorsService,
    BlacklistService,
    FavoritesService,
    TelegramService,
    DiscordMonitorService,
  ],
})
export class FeedModule {}
