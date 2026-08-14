import {
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  IsNotEmpty,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Chain, CatalogRole } from '@prisma/client';

/**
 * Cataloga (bookmark) um endereço público na conta. SEM assinatura — não implica posse;
 * é só uma busca salva sobre uma carteira, cujos dados on-chain são compartilhados.
 */
export class CatalogWalletDto {
  @ApiProperty({ enum: Chain, description: 'Blockchain da carteira' })
  @IsEnum(Chain)
  chain: Chain;

  @ApiProperty({
    description: 'Endereço da carteira (0x… para EVM; base58 para Solana)',
    example: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64) // base58 Solana chega a ~44; 0x EVM = 42. 64 cobre com folga.
  address: string;

  @ApiPropertyOptional({
    enum: CatalogRole,
    description:
      'Papel no catálogo (TRACKED = acompanhada; SOURCE = fonte). Default TRACKED.',
  })
  @IsOptional()
  @IsEnum(CatalogRole)
  role?: CatalogRole;

  @ApiPropertyOptional({
    description: 'Rótulo opcional para o usuário identificar a carteira',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  label?: string;
}

export class UpdateWalletDto {
  @ApiPropertyOptional({ description: 'Novo rótulo (por usuário)' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  label?: string;
}
