import {
  ArrayMaxSize,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class RequestVoucherDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(66) // 0x + 64 hex chars (Vara address)
  account: string;

  /**
   * Deprecated compatibility field. Older clients sent target program IDs here.
   * The backend now issues unrestricted vouchers with code upload enabled, so
   * values in this array are accepted for shape compatibility but ignored.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(66, { each: true })
  programs?: string[];

  /**
   * DEPRECATED: legacy `{ account, program: string }` shape. Accepted only so
   * the service can emit a specific migration error instead of the generic
   * "programs must be an array" from class-validator. Will be removed after
   * skills migration (task #15) lands.
   */
  @IsOptional()
  @IsString()
  @MaxLength(66)
  program?: string;
}
