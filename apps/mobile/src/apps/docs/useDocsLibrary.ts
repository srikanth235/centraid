import { useMemo } from 'react';
import { useReplicaQuery } from '../../kit/hooks/useReplicaQuery';
import { buildDrive } from './docs-model';

export function useDocsLibrary() {
  const documents = useReplicaQuery(
    'docs',
    useMemo(() => ({ entity: 'core.document' }), []),
  );
  const contents = useReplicaQuery(
    'docs',
    useMemo(() => ({ entity: 'core.content_item' }), []),
  );
  const tags = useReplicaQuery(
    'docs',
    useMemo(() => ({ entity: 'core.tag' }), []),
  );
  const concepts = useReplicaQuery(
    'docs',
    useMemo(() => ({ entity: 'core.concept' }), []),
  );
  const schemes = useReplicaQuery(
    'docs',
    useMemo(() => ({ entity: 'core.concept_scheme' }), []),
  );
  const custody = useReplicaQuery(
    'docs',
    useMemo(() => ({ entity: 'blob.custody_state' }), []),
  );
  return useMemo(
    () => ({
      ...buildDrive(
        documents.rows,
        contents.rows,
        tags.rows,
        concepts.rows,
        schemes.rows,
        custody.rows,
      ),
      loading: documents.loading || contents.loading,
      error: documents.error ?? contents.error,
    }),
    [
      concepts.rows,
      contents.error,
      contents.loading,
      contents.rows,
      custody.rows,
      documents.error,
      documents.loading,
      documents.rows,
      schemes.rows,
      tags.rows,
    ],
  );
}
