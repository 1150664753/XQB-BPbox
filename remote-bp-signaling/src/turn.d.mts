export interface TurnClaims { sub: string; jti: string; exp: number; iat: number; aud: string }
export interface TurnEnvironment {
  TURN_ACCESS_PASSWORD?: string;
  TURN_AUTH_SIGNING_KEY?: string;
  WTN_APP_ID?: string;
  WTN_APP_KEY?: string;
  WTN_API_DOMAIN?: string;
  WTN_TURN_TTL_SECONDS?: string;
  TURN_AUTH?: DurableObjectNamespace<import('./turnAuth').TurnAuthority>;
}
export interface TurnCredentials { iceServers: { urls: string[]; username: string; credential: string }[]; expiresAt: number }
export interface TurnGrant extends TurnClaims { expiresAt: number; requestTimes: number[]; cache: Record<string, TurnCredentials> }
export const AUTH_SECONDS: number;
export const turnErrors: Record<string, string>;
export function digest(value: string): Promise<string>;
export function signToken(secret: string, claims: object): Promise<string>;
export function verifyToken(env: TurnEnvironment, token: unknown, allowExpired?: boolean): Promise<TurnClaims>;
export function checkPassword(env: TurnEnvironment, password: unknown): Promise<void>;
export function authorizeTurn(env: TurnEnvironment, accessCode?: string): Promise<null>;
export function turnPermission(env: TurnEnvironment, grant?: TurnGrant | null): Promise<boolean>;
export function issueTurnCredentials(env: TurnEnvironment, grant: TurnGrant | null | undefined, peerKey: string, fetcher?: typeof fetch): Promise<TurnCredentials>;
