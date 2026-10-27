import { IsArray, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class BroadcastNotificationDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  title: string;

  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  content: string;

  /** 不传或空数组表示发给所有启用用户 */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  userIds?: string[];
}
