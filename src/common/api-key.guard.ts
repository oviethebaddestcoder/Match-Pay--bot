import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Protects internal REST endpoints (e.g. the orders API) with a static API
 * key passed as `x-api-key`. This is intentionally simple - the primary
 * interface for MatchPay is the WhatsApp bot, which has its own auth model
 * entirely (a seller IS their verified WhatsApp number). This REST surface
 * exists for internal tooling/dashboards and must not be left open: without
 * this guard, anyone who finds the endpoint could create orders attributed
 * to an arbitrary sellerId, or list every order (including payment
 * references) across every seller on the platform.
 *
 * For anything beyond a hackathon demo, replace this with per-seller
 * authenticated sessions (e.g. JWT issued after WhatsApp verification)
 * rather than one shared key for all internal access.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const providedKey = request.headers['x-api-key'];
    const expectedKey = this.config.get<string>('ADMIN_API_KEY');

    if (!expectedKey) {
      // Fail closed: an unset key must never mean "no auth required".
      throw new UnauthorizedException('Server misconfigured: ADMIN_API_KEY not set');
    }

    if (!providedKey || providedKey !== expectedKey) {
      throw new UnauthorizedException('Invalid or missing API key');
    }

    return true;
  }
}
