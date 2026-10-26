// in memory on purpose, so a relaunch never replays the tutorial. Home consumes it instead of
// onboarding pushing the route because /tutorial is behind the onboardingComplete guard
let pending = false;

export function requestTutorial(): void {
  pending = true;
}

export function consumeTutorialRequest(): boolean {
  const wasPending = pending;
  pending = false;
  return wasPending;
}
