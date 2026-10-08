/**
 * EPIC AI — HTTP guards и ошибки.
 *
 * Вынесено отдельно от server.ts, чтобы модули предметной области
 * (audit, users, ai, knowledge...) не создавали циклических импортов.
 */
import type { FastifyRequest, FastifyReply } from 'fastify';
import { authenticate, type AuthContext } from '../auth/session.js';
import { hasPermission } from '../permissions/catalog.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

export class HttpError extends Error {
  constructor(public statusCode: number, message: string, public code?: string) {
    super(message);
  }
}

export class UnauthorizedError extends HttpError {
  constructor(message = 'Требуется авторизация') { super(401, message, 'unauthorized'); }
}

export class ForbiddenError extends HttpError {
  constructor(message = 'Недостаточно прав') { super(403, message, 'forbidden'); }
}

export class NotFoundError extends HttpError {
  constructor(message = 'Не найдено') { super(404, message, 'not_found'); }
}

export class BadRequestError extends HttpError {
  constructor(message = 'Некорректный запрос') { super(400, message, 'bad_request'); }
}

/** Guard: требует авторизации и активного (не заблокированного) аккаунта. */
export async function requireAuth(req: FastifyRequest, _reply?: FastifyReply): Promise<AuthContext> {
  const auth = await authenticate(req);
  if (!auth) throw new UnauthorizedError();
  if (auth.user.status === 'blocked') {
    throw new ForbiddenError('Аккаунт заблокирован. Использование Epic AI запрещено.');
  }
  req.auth = auth;
  return auth;
}

/** Guard: требует все перечисленные permissions. */
export function requirePermission(...perms: string[]) {
  return async (req: FastifyRequest, _reply?: FastifyReply): Promise<AuthContext> => {
    const auth = await requireAuth(req);
    const missing = perms.filter((p) => !hasPermission(auth.permissions, p));
    if (missing.length) throw new ForbiddenError(`Недостаточно прав: ${missing.join(', ')}`);
    return auth;
  };
}

/** Guard: требует любой из перечисленных permissions. */
export function requireAnyPermission(...perms: string[]) {
  return async (req: FastifyRequest, _reply?: FastifyReply): Promise<AuthContext> => {
    const auth = await requireAuth(req);
    if (!perms.some((p) => hasPermission(auth.permissions, p))) {
      throw new ForbiddenError(`Требуется одно из прав: ${perms.join(', ')}`);
    }
    return auth;
  };
}

/** Опциональная авторизация: не бросает ошибку, если сессии нет. */
export async function optionalAuth(req: FastifyRequest): Promise<AuthContext | null> {
  const auth = await authenticate(req);
  if (auth) req.auth = auth;
  return auth;
}
