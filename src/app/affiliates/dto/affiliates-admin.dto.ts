import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Max, Min, ValidateIf } from 'class-validator';

import { MAX_RATE_BPS } from '../commission';

/*
 * DTOs de administração do programa de afiliados.
 *
 * Os percentuais viajam em BASIS POINTS (2000 = 20%), nunca em fração: é a
 * mesma unidade em que são gravados e aplicados, então não há conversão no
 * meio do caminho para introduzir erro de arredondamento em dinheiro.
 */

export class UpdateAffiliateSettingsDto {
  @ApiProperty({
    description: 'Percentual de quem indicou direto, em basis points',
    example: 2000,
    minimum: 0,
    maximum: MAX_RATE_BPS,
  })
  @IsInt()
  @Min(0)
  @Max(MAX_RATE_BPS)
  level1Bps: number;

  @ApiProperty({
    description: 'Percentual de quem indicou o indicador, em basis points',
    example: 500,
    minimum: 0,
    maximum: MAX_RATE_BPS,
  })
  @IsInt()
  @Min(0)
  @Max(MAX_RATE_BPS)
  level2Bps: number;
}

export class SetAffiliateRatesDto {
  /*
   * Ausente, null e 0 são TRÊS coisas diferentes aqui:
   *   ausente → não mexe neste nível
   *   null    → apaga a exceção e volta ao padrão global
   *   0       → zera a comissão deste nível, mantendo o vínculo
   * O `ValidateIf` é o que deixa o null passar pelo `@IsInt`.
   */
  @ApiPropertyOptional({
    description:
      'Percentual negociado do nível 1, em basis points. null volta ao padrão.',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(MAX_RATE_BPS)
  level1Bps?: number | null;

  @ApiPropertyOptional({
    description:
      'Percentual negociado do nível 2, em basis points. null volta ao padrão.',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(MAX_RATE_BPS)
  level2Bps?: number | null;
}
