import { IsNumber, IsOptional, IsPositive, IsString, MinLength } from 'class-validator';

export class CreateOrderDto {
  @IsString()
  sellerId: string;

  @IsString()
  @MinLength(1)
  buyerName: string;

  @IsOptional()
  @IsString()
  buyerWhatsapp?: string;

  @IsNumber()
  @IsPositive()
  amount: number;
}
