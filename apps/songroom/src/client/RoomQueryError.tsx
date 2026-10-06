import { errorMessage } from "./room-http";

export function QueryError({
  error,
  retrying,
  retry
}: {
  error: unknown;
  retrying: boolean;
  retry: () => void;
}) {
  return (
    <div className="room-query-error">
      <p className="form-message" role="alert">
        {errorMessage(error)}
      </p>
      <button className="secondary-button" type="button" disabled={retrying} onClick={retry}>
        {retrying ? "读取中…" : "重新读取"}
      </button>
    </div>
  );
}
