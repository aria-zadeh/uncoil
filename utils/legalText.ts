// mirrors docs/store/terms-of-use.md, privacy-policy.md and ai-notice.md. edit those first.
// no email or web addresses here, the hostname scan in scripts/verify fails on them

export type LegalDocId = 'terms' | 'privacy' | 'ai';

export interface LegalSection {
  readonly heading: string;
  // one string per paragraph. a leading "• " renders it as a list item
  readonly body: readonly string[];
}

export interface LegalDoc {
  readonly title: string;
  readonly updated: string;
  readonly intro: string;
  readonly sections: readonly LegalSection[];
}

// bump whenever any document below changes
export const LEGAL_LAST_UPDATED = 'October 9, 2026';

const CONTACT =
  'Open Uncoil on the App Store and tap App Support. The support page lists the email address.';

export const TERMS_OF_USE: LegalDoc = {
  title: 'Terms of Use',
  updated: LEGAL_LAST_UPDATED,
  intro:
    'These terms cover your use of the Uncoil app. By using Uncoil you agree to them. If you do not agree, do not use the app.',
  sections: [
    {
      heading: 'Age',
      body: [
        'Uncoil is for people 13 and older. If you are under 18, read these terms with a parent or guardian. By using Uncoil you confirm that a parent or guardian agrees to them for you.',
      ],
    },
    {
      heading: 'What Uncoil is',
      body: [
        'Uncoil is a planner for schoolwork. You add tasks, and Uncoil can suggest small steps for them, place them on a calendar, run a focus timer, and send reminders. Uncoil has no accounts and makes no internet connections. Everything you enter stays on your device.',
      ],
    },
    {
      heading: 'AI suggestions',
      body: [
        'Some features use a small AI language model that runs on your device. It suggests steps for a task, rewrites a step to be easier, and reads due dates out of text you paste.',
        '• The suggestions are produced automatically. Nobody reviews them before you see them.',
        '• They can be wrong, incomplete, generic, or not relevant to your assignment. Dates read from pasted text can be wrong.',
        '• Uncoil checks suggestions for offensive language, but no check is perfect. If you see something inappropriate, report it (see Contact) and turn the feature off in Profile, Model, Tailored steps.',
        "• Treat every suggestion as a starting point, not an instruction. Your teacher's instructions and your assignment's requirements always come first. Check every due date yourself.",
        '• You are responsible for judging every suggested step yourself, including whether it is safe. Use your own best judgment, and do not follow a step just because Uncoil suggested it.',
      ],
    },
    {
      heading: 'Schoolwork',
      body: [
        "Uncoil helps you plan and start work. It breaks an assignment into small first steps; it does not write or answer your assignment and is not a tutor. You are responsible for your own schoolwork and for following your school's and teacher's rules, including any rules about AI tools.",
      ],
    },
    {
      heading: 'Not advice',
      body: [
        'Uncoil is a productivity tool. It does not give medical, psychological, legal, or educational advice, it is not a health product, and it is not for emergencies.',
      ],
    },
    {
      heading: 'Reminders and calendar',
      body: [
        'Reminders and calendar placement are conveniences. A reminder can fail to appear, for example if notifications are off or the device is off. Do not rely on Uncoil as your only record of a deadline.',
      ],
    },
    {
      heading: 'Your content',
      body: [
        'What you enter in Uncoil is yours. It is stored only on your device. No one else can see it, back it up, or recover it. If you delete the app or use Delete all data, it is gone. Use Export my data if you want a copy. Where you send an exported file is your choice and your responsibility.',
      ],
    },
    {
      heading: 'Acceptable use',
      body: [
        "Use Uncoil only for lawful purposes and in line with Apple's terms. Do not try to make the app produce harmful or offensive content, and do not redistribute the app or its model except as their licenses allow.",
      ],
    },
    {
      heading: 'Licenses',
      body: [
        "Your right to use Uncoil comes from Apple's Licensed Application End User License Agreement (the Standard EULA). These terms add to it. If the two conflict, the Standard EULA controls. Uncoil includes open-source components under their own licenses, listed in Profile, Licenses. The AI model is a fine-tuned version of SmolLM2-360M-Instruct, used under the Apache License 2.0.",
      ],
    },
    {
      heading: 'No warranty',
      body: [
        'TO THE FULLEST EXTENT THE LAW ALLOWS, UNCOIL IS PROVIDED FREE, "AS IS" AND "AS AVAILABLE", WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, ACCURACY, AND NON-INFRINGEMENT. UNCOIL\'S DEVELOPER DOES NOT PROMISE THAT THE APP OR ITS SUGGESTIONS WILL BE ACCURATE, COMPLETE, UNINTERRUPTED, OR FREE OF ERRORS.',
      ],
    },
    {
      heading: 'Limit of liability',
      body: [
        'TO THE FULLEST EXTENT THE LAW ALLOWS, AND EXCEPT FOR PERSONAL INJURY WHERE THE LAW DOES NOT ALLOW A LIMIT, UNCOIL\'S DEVELOPER IS NOT LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR FOR LOST DATA, MISSED DEADLINES, OR GRADES, ARISING FROM YOUR USE OF UNCOIL OR ITS SUGGESTIONS. TOTAL LIABILITY FOR ANY CLAIM IS LIMITED TO FIFTY U.S. DOLLARS (US$50).',
        'Some places do not allow these limits, so they may not all apply to you. Nothing in these terms limits rights you have by law that cannot be waived.',
      ],
    },
    {
      heading: 'Changes',
      body: [
        'If these terms change, the new version will appear in the app and on the support page with a new date. Using Uncoil after a change means you accept the new terms.',
      ],
    },
    {
      heading: 'Governing law',
      body: [
        'These terms are governed by the laws of the United States, without regard to conflict-of-law rules. If you are a consumer in another country, you keep any protections the law of your country gives you.',
      ],
    },
    {
      heading: 'Apple',
      body: [
        'Apple is not a party to these terms and is not responsible for Uncoil or its content. Apple and its subsidiaries are third-party beneficiaries of these terms and may enforce them.',
      ],
    },
    { heading: 'Contact', body: [CONTACT] },
  ],
};

export const PRIVACY_POLICY: LegalDoc = {
  title: 'Privacy Policy',
  updated: LEGAL_LAST_UPDATED,
  intro:
    'Uncoil collects no data. No one receives your name, tasks, schedule, device identifiers, location, or how you use the app. Uncoil makes no internet connections at all.',
  sections: [
    {
      heading: 'What stays on your device',
      body: [
        "Everything you enter: your first name if you give one, tasks and their steps, due dates, busy times, focus sessions, and settings. It is stored in Uncoil's private storage on your device and protected by your device's own security, such as your passcode. No one else has a copy or a way to see it.",
      ],
    },
    {
      heading: 'The AI model',
      body: [
        'Step suggestions, easier rewrites of a step, and reading due dates from pasted text come from a small language model that is built into the app and runs on your device. Your text is processed on the device and never sent anywhere. The model does not learn from what you type. You can turn it off in Profile, Model, Tailored steps.',
      ],
    },
    {
      heading: 'What Uncoil does not have',
      body: [
        'No accounts or sign-in. No server. No analytics, no ads, and no tracking. No third-party code that collects data. No crash reporter. No access to your location, contacts, photos, camera, or microphone.',
      ],
    },
    {
      heading: 'Notifications',
      body: [
        "Reminders are scheduled on the device by Uncoil itself. No push service is involved. A reminder may show a task's title, including on the lock screen. You can change how notifications appear in the iOS Settings app.",
      ],
    },
    {
      heading: 'Export and import',
      body: [
        'Export my data writes a backup file on your device and opens the iOS share sheet. Where you send it is your choice; Uncoil never uploads it. Import data reads only the file you pick.',
      ],
    },
    {
      heading: 'Apple',
      body: [
        'Apple runs the App Store and handles your download under its own privacy policy. If you have chosen in iOS settings to share analytics with app developers, Apple may share anonymous crash reports and usage statistics with Uncoil\'s developer. These do not identify you and contain none of your tasks.',
      ],
    },
    {
      heading: 'Children',
      body: [
        'Uncoil is meant for high school students. Because it collects no personal information from anyone, it collects none from children under 13. Parents can see everything Uncoil stores by opening the app, and can delete all of it.',
      ],
    },
    {
      heading: 'Deleting your data',
      body: [
        'Profile, Delete all data removes everything Uncoil has stored. Deleting the app does the same. There is nothing anywhere else to delete.',
      ],
    },
    {
      heading: 'Your rights',
      body: [
        'Privacy laws such as the GDPR and the California Consumer Privacy Act give you rights over personal information a company holds about you. Uncoil holds none, so there is nothing to access, correct, sell, share, or delete. Uncoil does not sell or share personal information.',
      ],
    },
    {
      heading: 'Changes',
      body: [
        'If this policy changes, the new version will appear on the support page and in the app with a new date. If Uncoil ever starts collecting any data, this policy and the App Store privacy label will change first.',
      ],
    },
    { heading: 'Contact', body: [CONTACT] },
  ],
};

export const AI_NOTICE: LegalDoc = {
  title: 'About the AI',
  updated: LEGAL_LAST_UPDATED,
  intro:
    'Uncoil includes a small AI language model, a fine-tuned version of the open SmolLM2-360M-Instruct model (Apache License 2.0). It is built into the app, runs only on your iPhone, and never connects to the internet.',
  sections: [
    {
      heading: 'What it does',
      body: [
        '• Suggests three to seven small steps for a task.',
        '• Rewrites one step to be easier.',
        '• Reads assignments and due dates out of text you paste.',
      ],
    },
    {
      heading: 'What to know',
      body: [
        '• It can be wrong. Steps can be generic, miss part of the assignment, or not fit what your teacher asked for. Dates read from pasted text can be off.',
        '• Nobody reviews its suggestions before you see them.',
        '• Uncoil checks every suggestion for offensive language and replaces anything that fails with general steps. No check catches everything.',
        "• Your teacher's instructions always come first. Check every due date yourself.",
        '• Judge every step yourself, including whether it is safe. Use your own best judgment and do not just follow the steps.',
        "• It breaks work into first steps. It does not write or answer your assignment. Follow your school's rules about AI tools.",
      ],
    },
    {
      heading: 'Your data',
      body: ['What you type is processed on your device and never sent anywhere. The model does not learn from you.'],
    },
    {
      heading: 'Turning it off',
      body: ['Profile, Model, Tailored steps. With it off, Uncoil uses general steps written in advance instead.'],
    },
    {
      heading: 'Report a problem',
      body: [`If a suggestion is inappropriate or harmful, report it with what you typed and what it showed. ${CONTACT}`],
    },
  ],
};

export const LEGAL_DOCS: Readonly<Record<LegalDocId, LegalDoc>> = {
  terms: TERMS_OF_USE,
  privacy: PRIVACY_POLICY,
  ai: AI_NOTICE,
};

export const AI_STEPS_NOTICE = 'Suggested by AI on your phone. It can be wrong, so check it against your assignment.';

export const AI_EXTRACTION_NOTICE = 'Read automatically and can be wrong. Check each title and due date before you save.';

export const AI_SIMPLIFY_NOTICE = 'Rewritten by AI. Check it still matches your assignment.';

// the document names after the consent prefix are rendered as links
export const ONBOARDING_AI_NOTICE =
  'Uncoil suggests steps with an AI model that runs on your phone. It can make mistakes.';
export const ONBOARDING_CONSENT_PREFIX = 'By continuing, you agree to the ';
