import { IsEmail, IsEnum } from 'class-validator';
import { Role } from '@prisma/client';

/** Define a role de um usuário pelo email (endpoint admin). */
export class SetRoleDto {
  @IsEmail()
  email!: string;

  @IsEnum(Role)
  role!: Role;
}
