class RecordingHudController {
  private readonly hud = element<HTMLDivElement>("recording-hud");
  private readonly timer = element<HTMLSpanElement>("recording-timer");
  private readonly countdown = element<HTMLDivElement>("countdown-badge");
  private selection: Rect | null = null;
  private isRecording = false;
  private isCountingDown = false;
  private countdownValue: number | null = null;
  private recordingStartedAt: number | null = null;
  private timerHandle: number | null = null;

  setSelection(selection: Rect | null): void {
    this.selection = selection;
    this.update();
  }

  setCountdown(value: number): void {
    this.isCountingDown = true;
    this.countdownValue = value;
    this.update();
  }

  clearCountdown(): void {
    this.isCountingDown = false;
    this.countdownValue = null;
    this.update();
  }

  showRecordingPending(): void {
    this.isRecording = true;
    this.timer.textContent = "00:00";
    this.update();
  }

  startRecordingTimer(): void {
    this.stopTimer();
    this.isRecording = true;
    this.recordingStartedAt = Date.now();
    this.updateTimer();
    this.timerHandle = window.setInterval(() => this.updateTimer(), 250);
    this.update();
  }

  stopRecording(): void {
    this.isRecording = false;
    this.stopTimer();
    this.timer.textContent = "00:00";
    this.update();
  }

  refresh(): void {
    this.update();
  }

  private stopTimer(): void {
    if (this.timerHandle !== null) {
      window.clearInterval(this.timerHandle);
      this.timerHandle = null;
    }

    this.recordingStartedAt = null;
  }

  private updateTimer(): void {
    if (this.recordingStartedAt === null) {
      this.timer.textContent = "00:00";
      return;
    }

    this.timer.textContent = formatElapsed(Date.now() - this.recordingStartedAt);
  }

  private update(): void {
    const showHud = Boolean(this.selection && (this.isRecording || this.isCountingDown));
    this.hud.hidden = !showHud;
    this.countdown.hidden = !(this.selection && this.countdownValue !== null);

    if (!this.selection) {
      return;
    }

    const padding = 14;
    const hudLeft = Math.min(this.selection.x + this.selection.width - padding, window.innerWidth - 8);
    const hudTop = Math.max(this.selection.y + padding, 8);
    this.hud.style.left = `${hudLeft}px`;
    this.hud.style.top = `${hudTop}px`;

    if (this.countdownValue !== null) {
      this.countdown.textContent = String(this.countdownValue);
      this.countdown.style.left = `${this.selection.x + this.selection.width / 2}px`;
      this.countdown.style.top = `${this.selection.y + this.selection.height / 2}px`;
    }
  }
}

function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}
