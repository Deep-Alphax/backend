import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

import { REFERRAL_CODE_MAX, REFERRAL_CODE_MIN } from '../commission';

/*
 * DTOs do programa de afiliados.
 *
 * O ValidationPipe global roda com `whitelist` + `forbidNonWhitelisted`: campo
 * não declarado aqui é REJEITADO, não ignorado. O formato exato do código
 * (alfabeto permitido) é checado no serviço, por `referralCodeError`, para que
 * a regra viva num lugar só — testada — e não duplicada num `@Matches`.
 */

export class UpdateReferralCodeDto {
  @ApiProperty({
    description:
      'Novo código de indicação (letras, números, hífen e underscore)',
    minLength: REFERRAL_CODE_MIN,
    maxLength: REFERRAL_CODE_MAX,
  })
  @IsString()
  @MinLength(REFERRAL_CODE_MIN)
  @MaxLength(REFERRAL_CODE_MAX)
  code: string;
}
