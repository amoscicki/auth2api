# Codex Tool Bridge — plan (ACP -> Responses z trwałymi tool callami i natywnym steer)

Status: PLAN (nic nie wdrożone). Data: 2026-07-21.
Właściciel: auth2api, branch `codex/cursor-api-key-check` (ACP bridge: commity `752b1a9`, `6028b14`).
Referencyjny kod Codexa: `P:\tmp\codex-cli` (shallow clone openai/codex, do wywalenia po robocie).

## 1. Problem

Obecny bridge (`src/upstream/cursor-acp.ts`) wykonuje CAŁĄ turę Cursora w jednym SSE response:

- Tool-e Cursora lecą jako niestandardowe eventy `response.cursor.tool_call` (Codex je ignoruje)
  plus tekst w reasoning delta — efemeryczne, nic nie zostaje w historii/rollout, brak review w apce.
- Steer nigdy nie dochodzi: Codex dostarcza pending input **tylko między sampling requestami**
  (`codex-rs/core/src/session/turn.rs` L227-235, `get_pending_input`). Jedna wielka odpowiedź = zero granic
  = steer wisi wiecznie (stąd "2 wiszące steery" z sesji 2026-07-20).
- Endpoint steer w proxy to obejście (cancel -> send), pomija naturalny mechanizm Codexa.

## 2. Kluczowe fakty z kodu codex-rs (zweryfikowane w źródłach)

1. Parser SSE (`codex-api/src/sse/responses.rs`) rozumie m.in.: `response.created`,
   `response.output_item.added/done`, `response.output_text.delta`, `response.function_call_arguments.delta`,
   `response.custom_tool_call_input.delta`, `response.reasoning_summary_text.delta/done`,
   `response.reasoning_text.delta`, `response.completed/failed/incomplete`. Nieznane eventy ignoruje.
2. `OutputItemDone(function_call)` -> item trafia do historii (rollout, widoczny w UI, replay przy otwarciu wątku)
   i idzie do tool registry. Nieznana nazwa toola -> `FunctionCallError::RespondToModel("unsupported call: <name>")`
   (`core/src/tools/registry.rs` L436-454, L744-748) — tura NIE pada, Codex nagrywa `function_call_output`
   z tym tekstem i ustawia `needs_follow_up` -> **natychmiast wysyła kolejny sampling request z pełną historią**.
3. Pending input (steer z `turn/steer` w app-server, `core/src/session/inject.rs`) jest drenowany na początku
   każdej iteracji pętli sampling requestów. Czyli granica request/response = punkt steer. To jest ten "sygnał",
   na który czeka aplikacja.
4. Codex z `wire_api="responses"` wysyła pełny input (historię) w każdym requeście — korelacja continuation
   po naszym `call_id` w `function_call_output`, nie po `previous_response_id`.

## 3. Architektura docelowa: tool-boundary chunking

Jedna tura Cursora = N odpowiedzi Responses, cięcie na granicach tool calli.

```
Codex POST /v1/responses (user prompt)
  -> proxy: ACP session/prompt (tura Cursora startuje)
  -> stream: reasoning deltas + output_text deltas
  -> Cursor odpala tool -> proxy emituje:
       response.output_item.added/done  { type:"function_call", name:"cursor_shell",
                                          arguments:<rawInput JSON>, call_id:"call_cursor_<toolCallId>" }
       response.completed
  <- Codex: nagrywa function_call w historii (WIDOCZNY, TRWAŁY), tool nieznany ->
     function_call_output "unsupported call: cursor_shell" -> follow-up POST (pełna historia)
  -> proxy: rozpoznaje continuation po call_id, NIE wysyła nic do Cursora (tura dalej się kręci),
     streamuje zbuforowane update'y dalej... aż do następnego toola albo końca tury
  -> koniec tury Cursora (session/prompt resolved) -> message item + response.completed bez function_call
  <- Codex: brak toola do wykonania -> tura skończona
```

Steer: user wciska steer w apce -> `turn/steer` -> pending input -> dostarczony w NASTĘPNYM requeście
(po najbliższym tool callu). Proxy widzi w continuation nowy user message (nie tylko function_call_output)
-> ACP `session/cancel` + `session/prompt` ze steer textem na TEJ SAMEJ sesji (semantyka cancel->send,
zaakceptowana przez usera 2026-07-20). Endpoint /steer w proxy przestaje być potrzebny.

Mapowanie tool calli (ACP `ToolCall`/`ToolCallUpdate`: toolCallId, kind, title, rawInput, rawOutput, status, locations):

- nazwa: `cursor_<kind>` (kind: read|edit|delete|move|search|execute|think|fetch|switch_mode|other),
  sanityzacja `[a-zA-Z0-9_-]`; title do arguments.
- arguments: JSON z {title, rawInput, locations}.
- wynik toola (rawOutput/status z `tool_call_update`): do następnego chunka jako reasoning text
  (`[tool cursor_shell done] <skrót rawOutput>`) — function_call w Responses nie niesie outputu,
  a "unsupported call" jest generowane po stronie Codexa. (Do przetestowania w fazie 0, czy czytelne w UI.)

## 4. Otwarte ryzyka / do zweryfikowania testem

- [ ] R1: czy apka/TUI renderuje nieznany function_call sensownie (nazwa+argumenty) i czy przeżywa reopen wątku
  (history replay). Alternatywa gdy brzydko: `custom_tool_call` (też parsowany).
- [ ] R2: czy "unsupported call: X" w output nie skłania modelu-Cursora do przeprosin/pętli — Cursor tego NIE widzi
  (to trafia tylko do historii Codexa), ale kolejne prompty do Cursora nie mogą zawierać tej historii. Continuation
  nie wysyła nic do Cursora — OK, sprawdzić edge: nowa tura po zakończonej (fresh prompt z historią zawierającą
  unsupported-y; `continuationPrompt` bierze ostatni user item — zweryfikować).
- [ ] R3: wiele tooli równolegle w Cursorze — serializacja: emitujemy function_call w momencie STARTU toola,
  kolejne buforujemy do następnego chunka. Kolejność stabilna po czasie przyjścia update'ów.
- [ ] R4: timeout follow-upu — Codex może nie wrócić (kill apki). TurnRun musi mieć TTL + `session/cancel` przy porzuceniu.
- [ ] R5: `store=false`/brak `previous_response_id` — korelacja wyłącznie po `call_id` i thread headers (już używane
  w `stableConversationId`). Sprawdzić, co realnie przysyła app w headerach przy follow-upie.
- [ ] R6: idle timeout obecnego bridge'a (stream-messages-ms) musi być per-chunk, nie per-tura.
- [ ] R7: run-everything: ACP spawn ma już `--yolo` (`spawnAcp`), CLI transport ma `--force` po fixie 2026-07-20 — spójne.

## 5. Fazy i checklista

### Faza 0 — Recon i dowody (bez zmian w dist, lokalnie)

- [ ] Debug-log request body w proxy (tymczasowy env flag), zebrać realne kształty requestów Codexa:
  pierwszy prompt, follow-up po function_call_output, steer w pending input.
- [ ] Stub-test: ręcznie zwrócić z proxy response z syntetycznym `function_call` (name `cursor_probe`) i sprawdzić:
  (a) codex exec kontynuuje turę i wysyła follow-up z `function_call_output` "unsupported call",
  (b) w rollout jsonl jest function_call + output, (c) apka pokazuje tool call i przeżywa reopen (R1).
- [ ] Ustalić dokładny format input items w follow-upie (function_call_output shape, kolejność).

### Faza 1 — TurnRun: oddzielenie tury ACP od cyklu HTTP

- [ ] Refactor `cursor-acp.ts`: obiekt `TurnRun` per (conversation, session/prompt w locie):
  bufor update'ów, stan `streaming | awaiting_continuation | finished`, aktywny writer SSE.
- [ ] `session/prompt` żyje niezależnie od HTTP response; response tylko podłącza się do bufora.
- [ ] TTL + cancel przy porzuceniu (R4); idle per-chunk (R6).
- [ ] Unit testy stanu (tests/ już istnieje w repo).

### Faza 2 — Tool-boundary chunking + trwałe tool calle

- [ ] Mapowanie ACP tool_call -> function_call item (nazwy `cursor_<kind>`, arguments z rawInput/title/locations).
- [ ] Cięcie response na tool callu: domknięcie message/reasoning itemów, output_item.added/done, completed.
- [ ] Klasyfikacja przychodzącego requestu: nowy prompt / continuation (ostatnie itemy = function_call_output
  do naszych call_id) / steer (nowy user message) — nic nie wysyłać do Cursora przy czystym continuation.
- [ ] Wyniki tooli (tool_call_update, rawOutput) w następnym chunku jako reasoning text.
- [ ] Usunąć spam `[tool:...]` z reasoning przy tool_call (zastąpione prawdziwymi itemami).

### Faza 3 — Natywny steer

- [ ] Steer text wykryty w continuation -> `session/cancel` + `session/prompt(steer)` na tej samej sesji ACP.
- [ ] Wyłączyć/zdeprecjonować endpoint steer proxy (`steerCursorAcpResponse`) — steer idzie natywnie z apki.
- [ ] Test: 2 steery pod rząd nie wiszą (scenariusz z 2026-07-20).

### Faza 4 — Matrix testów e2e (lokalnie, composer = tanio/szybko)

Harness jak w poprzedniej sesji: `codex exec --skip-git-repo-check -m cursor-composer-2-fast '<prompt>'`
(+ `codex exec resume <id>`), profil bije w lokalny proxy 127.0.0.1:8317. Markery w promptach.

- [ ] T1: tura bez tooli (marker reply) — regresja continuation po resume.
- [ ] T2: tura z 1 toolem ("utwórz plik X o treści Y") — function_call w rollout, plik istnieje.
- [ ] T3: multi-tool (3+ komendy) — kolejność chunków, wszystkie calle w historii.
- [ ] T4: steer w trakcie długiej tury — przez `codex app-server` v2 `turn/steer` (skryptowo) lub apkę.
- [ ] T5: kontynuacja sesji Cursora między turami Codexa (marker z tury 1 przypomniany w turze 2).
- [ ] T6: reopen wątku w apce — tool calle nadal widoczne (R1).
- [ ] T7: fable5 (thinking) smoke — reasoning + tool calle razem.

### Faza 5 — Deploy na Sparka (host + kontener T3)

- [ ] `transport: "acp"` w config.yaml na Spark host i w kontenerze (dziś oba mają `cli` — root cause z 2026-07-20).
- [ ] Build + kopia dist, restart `auth2api.service` (host) i proxy w kontenerze (za zgodą usera, sesje!).
- [ ] Smoke z telefonu przez sparowany daemon: tool calle widoczne + steer działa.
- [ ] Commit + push auth2api (razem z niecommitowanym fixem `--force` z 2026-07-20).
- [ ] Aktualizacja CEX + notatki.

## 6. Artefakty

- Ten plan: `docs/codex-tool-bridge-plan.md`.
- Klon referencyjny: `P:\tmp\codex-cli` (usunąć po fazie 4/5).
- Poprzednie dowody: sesja Codexa `019f6f4d-b819-...` (markery SPARK_NATIVE_ACP_4K7, CONTINUATION_7Q9M),
  mapowanie sesji `cursor-acp-sessions.json` w auth-dir.
