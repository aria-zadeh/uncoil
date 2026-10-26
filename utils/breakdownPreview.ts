// a breakdown preview answers what the form said when "Break it down" was tapped. the
// screen keeps this snapshot beside the result and drops the result once they differ

export interface PreviewInput {
  title: string;
  subject: string;
  description: string;
}

// trimmed the same way the screen trims before asking for a preview
export function previewInputOf(title: string, subject: string, description: string): PreviewInput {
  return { title: title.trim(), subject: subject.trim(), description: description.trim() };
}

export function previewMatches(snapshot: PreviewInput, current: PreviewInput): boolean {
  return (
    snapshot.title === current.title &&
    snapshot.subject === current.subject &&
    snapshot.description === current.description
  );
}
