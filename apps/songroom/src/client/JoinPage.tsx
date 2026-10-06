import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { z } from "zod";
import { Link, useNavigate } from "react-router";
import { v7 as uuidv7 } from "uuid";
import { inviteCode, inviteInspectView, joinApplicationCommand, joinApplicationView, type JoinApplicationCommand } from "../shared/invite-contracts";
import { useInviteContext } from "./InviteContext";
import { InviteError } from "./InviteError";
import { inviteRequest } from "./invite-http";
import { RoomRequestError } from "./room-http";

export function JoinPage({ sessionId }: { sessionId: string }) {
  const { code, setCode } = useInviteContext();
  const [input, setInput] = useState(code);
  const [validation, setValidation] = useState("");
  const codeInput = useRef<HTMLInputElement>(null);
  const validCode = inviteCode.safeParse(code).success;
  useEffect(() => {
    setInput(code);
    const parsed = inviteCode.safeParse(code);
    setValidation(code && !parsed.success ? parsed.error.issues[0]!.message : "");
  }, [code]);
  useEffect(() => { if (!validCode) codeInput.current?.focus(); }, [validCode]);
  function inspect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = inviteCode.safeParse(input.trim());
    if (!parsed.success) {
      setValidation(parsed.error.issues[0]!.message);
      return;
    }
    setValidation("");
    setCode(parsed.data);
  }
  return <section className="rooms-page" aria-labelledby="join-heading">
    <Link className="back-link" to="/rooms">返回房间列表</Link>
    <div className="page-heading">
      <h1 id="join-heading">通过邀请申请加入</h1>
      <p>邀请只用于提交加入申请。房主批准前，你还不能查看房间内容。</p>
    </div>
    <form className="settings-card room-create-form" onSubmit={inspect} noValidate>
      <label>邀请码<input ref={codeInput} value={input} onChange={event => setInput(event.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} /></label>
      {validation && <p className="form-message" role="alert">{validation}</p>}
      <button className="secondary-button" type="submit">查看邀请</button>
    </form>
    {validCode && <JoinInspection key={code} code={code} sessionId={sessionId} />}
  </section>;
}

function JoinInspection({ code, sessionId }: { code: string; sessionId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["invite-inspect", sessionId, code],
    queryFn: ({ signal }) => inviteRequest("/invites/inspect", inviteInspectView, signal, { code }),
    retry: false
  });
  const [nickname, setNickname] = useState("");
  const [validation, setValidation] = useState("");
  const [lastCommand, setLastCommand] = useState<JoinApplicationCommand | null>(null);
  const nicknameInput = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (query.data && !query.data.isMember && !query.data.application) nicknameInput.current?.focus();
  }, [query.data]);
  const mutation = useMutation({
    mutationFn: (command: JoinApplicationCommand) => {
      controller.current = new AbortController();
      return inviteRequest("/join-applications", joinApplicationView, controller.current.signal, command);
    },
    retry: false,
    onSuccess: application => {
      if (controller.current?.signal.aborted) return;
      void queryClient.invalidateQueries({ queryKey: ["join-applications", sessionId] });
      queryClient.setQueryData(["join-application", sessionId, application.id], application);
      navigate(`/application/${application.id}`);
    },
    onError: failure => {
      if (failure instanceof RoomRequestError && ["IDEMPOTENCY_CONFLICT", "IDEMPOTENCY_KEY_EXPIRED"].includes(failure.code)) setLastCommand(null);
    }
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutation.isPending || !query.data || query.data.isMember || query.data.application) return;
    const parsed = joinApplicationCommand.safeParse({ code, nickname, idempotencyKey: lastCommand?.idempotencyKey ?? uuidv7() });
    if (!parsed.success) {
      setValidation(parsed.error.issues[0]!.message);
      return;
    }
    const command = lastCommand?.nickname === parsed.data.nickname ? lastCommand : { ...parsed.data, idempotencyKey: uuidv7() };
    setLastCommand(command);
    setValidation("");
    mutation.mutate(command);
  }
  function reload() {
    mutation.reset();
    void query.refetch();
  }
  if (query.isError) return <InviteError error={query.error} retry={reload} />;
  if (!query.data) return <p role="status">正在读取邀请…</p>;
  const view = query.data;
  return <section className="settings-card room-create-form" aria-labelledby="join-room-heading">
    <h2 id="join-room-heading">申请加入{view.room.name}</h2>
    {view.isMember ? <>
      <p role="status">你已经是这个房间的成员。</p>
      <Link className="text-link" to="/rooms">前往我的房间</Link>
    </> : view.application ? <>
      <p role="status">你已有这个房间的待处理申请，请等待房主审批。</p>
      <Link className="text-link" to={`/application/${view.application.id}`}>查看原申请</Link>
    </> : <form className="auth-form join-nickname-form" onSubmit={submit} noValidate>
      <label>拟用房间昵称<input ref={nicknameInput} value={nickname} disabled={mutation.isPending} onChange={event => setNickname(event.target.value)} autoComplete="off" />
        <span className="field-help">1 到 12 个字符，只用于这个房间。申请期间不会占用昵称。</span>
      </label>
      {validation && <p className="form-message" role="alert">{validation}</p>}
      <button className="primary-button" type="submit" disabled={mutation.isPending}>{mutation.isPending ? "提交中…" : "提交加入申请"}</button>
      {mutation.isError && <InviteError error={mutation.error} retry={reload} />}
    </form>}
  </section>;
}
