import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { AlertKind } from '@prisma/client';

/** Cria uma regra de alerta. O valor é normalizado no service. */
export class CreateAlertRuleDto {
  @IsEnum(AlertKind)
  kind!: AlertKind;

  // Termo de 2+ caracteres: com 1 ("a", "$") o alerta dispararia em quase toda
  // captura — ruído para o usuário e carga para o push.
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  @Matches(/\S/, { message: 'value must not be blank' })
  value!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;
}

/** Liga/desliga ou renomeia. Trocar o alvo = apagar e criar outra. */
export class UpdateAlertRuleDto {
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;
}

export class NotificationsQueryDto {
  /** Id da última notificação recebida (paginação por cursor, sem OFFSET). */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

class PushKeysDto {
  @IsString()
  @MaxLength(200)
  p256dh!: string;

  @IsString()
  @MaxLength(100)
  auth!: string;
}

/** Formato do `PushSubscription.toJSON()` do navegador. */
export class PushSubscribeDto {
  @IsString()
  @MaxLength(1024)
  endpoint!: string;

  @ValidateNested()
  @Type(() => PushKeysDto)
  keys!: PushKeysDto;
}

export class PushUnsubscribeDto {
  @IsString()
  @MaxLength(1024)
  endpoint!: string;
}
