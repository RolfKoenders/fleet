/**
 * The smallest terminal that can show what `fleet push` writes to stderr: text, newlines, SGR colors, the cursor
 * moved up to a line start (`ESC [ n F`), erase to the end of the screen (`ESC [ J`) and the cursor shown or hidden.
 * Lines wrap at `cols`, as a terminal's do. Anything else is an error, so a new control code cannot slip by unseen.
 */
const TOKENS = /\u001b\[(\d*)F|(\u001b\[J)|\u001b\[\?25[lh]|(\u001b\[[0-9;]*m)|(\n)|([^\u001b\n]+)|(\u001b[^]?)/gu;

export class Screen {
  readonly cols: number;
  private lines = [""];
  private row = 0;
  private col = 0;

  constructor(cols: number) {
    this.cols = cols;
  }

  write(text: string): void {
    for (const m of text.matchAll(TOKENS)) {
      if (m[1] !== undefined) {
        this.row = Math.max(0, this.row - Number(m[1] || 1));
        this.col = 0;
      } else if (m[2] !== undefined) {
        this.lines.length = this.row + 1;
        this.lines[this.row] = "";
        this.col = 0;
      } else if (m[3] !== undefined) this.lines[this.row] += m[3];
      else if (m[4] !== undefined) this.down();
      else if (m[5] !== undefined) this.text(m[5]);
      else if (m[6] !== undefined) throw new Error(`the screen has no ${JSON.stringify(m[6])}`);
    }
  }

  private down(): void {
    this.row++;
    this.lines[this.row] ??= "";
    this.col = 0;
  }

  private text(chunk: string): void {
    let rest = [...chunk];
    while (rest.length > 0) {
      if (this.col >= this.cols) this.down();
      const room = this.cols - this.col;
      this.lines[this.row] += rest.slice(0, room).join("");
      this.col += Math.min(room, rest.length);
      rest = rest.slice(room);
    }
  }

  /** Everything written so far as text with SGR codes, one string with a newline between lines, without the empty line the cursor waits on. */
  ansi(): string {
    const lines = this.lines.slice();
    if (lines[lines.length - 1] === "") lines.pop();
    return lines.join("\n");
  }
}
