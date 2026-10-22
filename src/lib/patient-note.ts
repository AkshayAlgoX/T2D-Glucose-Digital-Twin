/**
 * The note for the patient in the clinician summary: fixed sentences in English and Hindi, filled only
 * with values the backend served. Each language has the same sentences in the same order, so every number
 * appears in both. No advice is given beyond "talk to your doctor". The Hindi has not yet had a review by
 * a native-speaking clinician; the summary says so.
 */
export type NoteLang = 'en' | 'hi';

export interface NoteInput {
  time: string;
  glucose: number | null;
  risk: number | null;
  scenario: { change: string; from: number | null; to: number | null } | null;
}

const pct = (p: number) => `${(p * 100).toFixed(0)}%`;

export function patientNote(lang: NoteLang, n: NoteInput): string[] {
  const hi = lang === 'hi';
  const lines: string[] = [];
  lines.push(n.glucose == null
    ? (hi ? `${n.time} बजे की ग्लूकोज़ रीडिंग उपलब्ध नहीं है।` : `No glucose reading is available for ${n.time}.`)
    : (hi ? `${n.time} बजे आपका ग्लूकोज़ ${n.glucose} mg/dL था।` : `Your glucose at ${n.time} was ${n.glucose} mg/dL.`));
  if (n.risk != null) {
    lines.push(hi
      ? `मॉडल का अनुमान है कि अगले 2 घंटों में ग्लूकोज़ के 180 mg/dL से ऊपर जाने की संभावना ${pct(n.risk)} है। यह एक अनुमान है, माप नहीं।`
      : `The model estimates a ${pct(n.risk)} chance that your glucose goes above 180 mg/dL in the next 2 hours. This is an estimate, not a measurement.`);
  }
  if (n.scenario && n.scenario.from != null && n.scenario.to != null) {
    lines.push(hi
      ? `एक कंप्यूटर सिमुलेशन में, "${n.scenario.change}" से यह अनुमानित संभावना ${pct(n.scenario.from)} से बदलकर ${pct(n.scenario.to)} हो गई। यह केवल सिमुलेशन है, परखा हुआ उपचार-प्रभाव नहीं।`
      : `In a computer simulation, "${n.scenario.change}" changed this estimated chance from ${pct(n.scenario.from)} to ${pct(n.scenario.to)}. This is only a simulation, not a tested treatment effect.`);
  }
  lines.push(hi
    ? 'यह नोट कृत्रिम (सिंथेटिक) डेटा पर चलने वाले एक शोध-प्रोटोटाइप से है। इसके आधार पर अपना खाना, गतिविधि या दवाइयाँ न बदलें; अपने डॉक्टर से बात करें।'
    : 'This note comes from a research prototype that uses synthetic data. Do not change your food, activity or medicines because of it; talk to your doctor.');
  return lines;
}
