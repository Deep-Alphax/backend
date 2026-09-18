import { Module } from '@nestjs/common';

import { PrismaModule } from '../../prisma/prisma.module';
import { AffiliatesAdminController } from './affiliates-admin.controller';
import { AffiliatesController } from './affiliates.controller';
import { AffiliatesService } from './affiliates.service';

/**
 * Programa de afiliados: 20% recorrente sobre cada fatura paga de um indicado.
 *
 * O serviço é EXPORTADO porque dois módulos de fora escrevem nele: `auth`
 * (resolve o código no cadastro) e `billing` (apura a comissão no
 * `invoice.paid`). Nenhum deles conhece o schema de comissão — só chama.
 */
@Module({
  imports: [PrismaModule],
  controllers: [AffiliatesController, AffiliatesAdminController],
  providers: [AffiliatesService],
  exports: [AffiliatesService],
})
export class AffiliatesModule {}
