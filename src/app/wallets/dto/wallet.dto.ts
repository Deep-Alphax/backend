import { IsEnum, IsOptional, IsString, IsBoolean, MaxLength, IsNotEmpty } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Chain } from '@prisma/client';

/** Pedido de nonce para provar posse da carteira (passo 1 da verificação). */
export class RequestWalletNonceDto {
  @ApiProperty({ enum: Chain, description: 'Blockchain da carteira' })
  @IsEnum(Chain)
  chain: Chain;

  @ApiProperty({ description: 'Endereço da carteira (0x… EVM; base58 Solana)' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  address: string;
}

export class CreateWalletDto {
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

  @ApiProperty({
    description:
      'Assinatura da mensagem de verificação (prova de posse). Hex 0x… no EVM; base64 no Solana.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  signature: string;

  @ApiPropertyOptional({ description: 'Rótulo opcional para o usuário identificar a carteira' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  label?: string;
}

export class UpdateWalletDto {
  @ApiPropertyOptional({ description: 'Novo rótulo' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  label?: string;

  @ApiPropertyOptional({ description: 'Ativa/desativa a carteira (inativa não sincroniza)' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
