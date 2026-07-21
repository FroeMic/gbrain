import type { AuthInfo, Operation } from '../core/operations.ts';
import { hasScope } from '../core/scope.ts';
import type { DispatchOpts } from './dispatch.ts';

export type HttpExecutionMode = 'remote' | 'trusted_host';

type HttpAuthInfo = AuthInfo & { takesHoldersAllowList?: string[] };

export interface HttpExecutionPolicy {
  readonly mode: HttpExecutionMode;
  publishedOperations(catalog: readonly Operation[]): Operation[];
  admitsOperation(grantedScopes: readonly string[], operation: Operation): boolean;
  dispatchOptions(auth: HttpAuthInfo): Pick<
    DispatchOpts,
    'remote' | 'sourceId' | 'takesHoldersAllowList' | 'auth' | 'redactInternalErrors'
  >;
}

export function parseHttpExecutionMode(value: string | undefined): HttpExecutionMode {
  if (value === undefined || value === 'remote') return 'remote';
  if (value === 'trusted_host') return 'trusted_host';
  throw new Error(`Invalid --execution-mode '${value}'. Expected remote or trusted_host.`);
}

export function createHttpExecutionPolicy(
  mode: HttpExecutionMode,
  startupSourceId: string,
): HttpExecutionPolicy {
  if (mode === 'trusted_host') {
    return {
      mode,
      publishedOperations: catalog => [...catalog],
      admitsOperation: () => true,
      dispatchOptions: auth => ({
        remote: false,
        sourceId: startupSourceId,
        auth,
        redactInternalErrors: true,
      }),
    };
  }

  return {
    mode,
    publishedOperations: catalog => catalog.filter(operation => !operation.localOnly),
    admitsOperation: (grantedScopes, operation) =>
      hasScope(grantedScopes, operation.scope || 'read'),
    dispatchOptions: auth => ({
      remote: true,
      sourceId: auth.sourceId ?? 'default',
      takesHoldersAllowList: auth.takesHoldersAllowList ?? ['world'],
      auth,
      redactInternalErrors: true,
    }),
  };
}
