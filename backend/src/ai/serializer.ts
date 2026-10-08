/**
 * EPIC AI — сериализация источников для клиента.
 *
 * Окно источников  обязано показывать: найденные статьи, пункты,
 * подпункты, название документа, категорию, дату редакции, ссылку на оригинал
 * и кнопку «Открыть источник ↗».
 *
 * Все эти поля берутся из базы, AI не имеет права их формировать.
 */
import type { RetrievedSource } from './rag/retrieval.js';

export interface SourceDto {
  index: number;
  documentId: number;
  versionId: number;
  version: number;
  docType: 'RULE' | 'LAW';
  docTypeLabel: string;
  title: string;
  category: string | null;
  section: string | null;
  /** Пункт/статья/заголовок фрагмента. */
  heading: string | null;
  content: string;
  url: string;
  /** Дата редакции в формате : 05.10.2026 20:14 */
  revisionLabel: string;
  threadId: number;
  postId: number | null;
  score: number;
  matchedTerms: string[];
  openLabel: string;
}

export function serializeSource(s: RetrievedSource): SourceDto {
  return {
    index: s.index,
    documentId: s.documentId,
    versionId: s.versionId,
    version: s.version,
    docType: s.docType,
    docTypeLabel: s.docType === 'LAW' ? 'Законодательная база' : 'Правила',
    title: s.title,
    category: s.category,
    section: s.section,
    heading: s.heading,
    content: s.content,
    url: s.url,
    revisionLabel: s.revisionLabel,
    threadId: s.threadId,
    postId: s.postId,
    score: s.score,
    matchedTerms: s.matchedTerms,
    openLabel: 'Открыть источник ↗',
  };
}

export function serializeSources(list: RetrievedSource[]): SourceDto[] {
  return (list ?? []).map(serializeSource);
}
