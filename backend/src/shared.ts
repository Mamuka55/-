/**
 * EPIC AI — типизированный мост к общему файлу дизайн-токенов и справочников.
 *
 * shared/tokens.js — единственный источник цветов, ролей, статусов и категорий.
 * Он используется одновременно backend'ом, Electron main и renderer'ом,
 * поэтому написан на чистом JS. Здесь мы добавляем к нему типы.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export interface RoleSpec { code: string; name: string; color: string; level: number; system?: boolean; }
export interface FeedbackCategorySpec { id: string; label: string; }
export interface ReportAnalysisSpec { id: string; label: string; }
export interface ModeSpec { id: 'rules' | 'laws'; label: string; docType: 'RULE' | 'LAW'; }
export interface SyncStateSpec { id: string; label: string; color: string; }
export interface SplashStepSpec { id: string; label: string; }

export interface ColorsSpec {
  accent: string; accentBright: string; accentMid: string;
  bgBase: string; bgDark: string; bgSurface: string; bgMuted: string;
  textPrimary: string; textMuted: string; textSubtle: string;
  danger: string; warning: string; info: string;
}
export interface GlassSpec { panel: string; surface: string; muted: string; base: string; stroke: string; strokeStrong: string; }
export interface DefaultsSpec {
  main: { width: number; height: number; minWidth: number; maxWidth: number; minHeight: number; maxHeight: number };
  sources: { width: number; height: number; gap: number; offsetY: number };
  splash: { width: number; height: number };
  hotkey: string;
  syncIntervalMinutes: number;
  settings: Record<string, any>;
}

const require_ = createRequire(import.meta.url ?? fileURLToPath(import.meta.url));
const here = dirname(fileURLToPath(import.meta.url));
// backend/src → epic-ai/shared/tokens.js
const tokensPath = resolve(here, '../../shared/tokens.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const T: any = require_(tokensPath);

export const COLORS: ColorsSpec = T.COLORS;
export const GLASS: GlassSpec = T.GLASS;
export const ROLES: RoleSpec[] = T.ROLES;
export const ROLE_BY_CODE: Record<string, RoleSpec> = T.ROLE_BY_CODE;
export const ACCOUNT_STATUS: string[] = T.ACCOUNT_STATUS;
export const REPORT_STATUS: { NEW: 'new'; IN_PROGRESS: 'in_progress'; RESOLVED: 'resolved' } = T.REPORT_STATUS;
export const REPORT_STATUS_LABEL: Record<string, string> = T.REPORT_STATUS_LABEL;
export const FEEDBACK_CATEGORIES: FeedbackCategorySpec[] = T.FEEDBACK_CATEGORIES;
export const REPORT_ANALYSIS: ReportAnalysisSpec[] = T.REPORT_ANALYSIS;
export const DOC_TYPES: { RULE: 'RULE'; LAW: 'LAW' } = T.DOC_TYPES;
export const MODES: Record<'rules' | 'laws', ModeSpec> = T.MODES;
export const SYNC_STATE: Record<'OK' | 'UPDATES' | 'ERROR' | 'RUNNING', SyncStateSpec> = T.SYNC_STATE;
export const SYNC_RESULT: { NEW: 'NEW'; UPDATED: 'UPDATED'; UNCHANGED: 'UNCHANGED'; ARCHIVED: 'ARCHIVED' } = T.SYNC_RESULT;
export const SPLASH_STEPS: SplashStepSpec[] = T.SPLASH_STEPS;
export const DEFAULTS: DefaultsSpec = T.DEFAULTS;
export const DATE_FORMAT: { date: string; dateTime: string } = T.DATE_FORMAT;

export const tokens = T;
export default T;
