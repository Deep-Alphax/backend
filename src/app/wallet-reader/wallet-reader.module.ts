import { Module } from '@nestjs/common';
import { WalletReaderController } from './wallet-reader.controller';
import { WalletReaderService } from './wallet-reader.service';

/** Wallet Reader (KOL Index) — varredura de sidewallets/copytraders. */
@Module({
  controllers: [WalletReaderController],
  providers: [WalletReaderService],
})
export class WalletReaderModule {}
