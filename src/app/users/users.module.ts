import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../prisma/prisma.module';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';

/**
 * Usuários: re-hospedagem e serving do avatar. `UsersService` é exportado para o
 * AuthModule (fluxo Google) re-hospedar a foto no login.
 */
@Module({
  imports: [PrismaModule, HttpModule, ConfigModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
