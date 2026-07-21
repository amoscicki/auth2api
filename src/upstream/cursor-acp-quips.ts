/** Idle-stream quips: emitted as reasoning filler while Cursor is quiet. */
export const IDLE_QUIPS: string[] = [
  "overinżynieruję",
  "spinaczuję",
  "pojntjejuję",
  "zastanawiam się jak wkurwić Arka",
  "zastanawiam się jak striggerować Kamila",
  "obmyślam plan przejęcia wszechświata",
  "szukam dziury w całym",
  "przerzucam gnój widłami",
  "jaram zioło",
  "dosypuję węgla do pieca",
  "liczę tokeny na palcach",
  "kompiluję wymówki",
  "refaktoruję sens życia",
  "czekam aż się skompiluje",
  "mieszam w kotle technicznego długu",
  "debuguję rzeczywistość printfami",
  "wygrzewam cache",
  "głaszczę regexy pod włos",
  "negocjuję z garbage collectorem",
  "podlewam drzewko zależności",
  "kręcę beczkę z entropią",
  "symuluję ciężką pracę",
  "zamiatam wyjątki pod dywan",
  "prostuję krzywe ścieżki w PATH",
  "medytuję nad pustym diffem",
  "hoduję race condition w piwnicy",
  "spuszczam parę z event loopa",
  "dokręcam śrubki w potoku CI",
  "wietrzę kontener",
  "ostrzę widelec do merge'a",
];

export function randomQuip(): string {
  return IDLE_QUIPS[Math.floor(Math.random() * IDLE_QUIPS.length)];
}
