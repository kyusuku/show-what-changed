export { feedback } from './feedback.mjs';

export const columns = [
  { id: 'ready', title: 'Ready to make', description: 'Small projects with a clear next step.' },
  { id: 'making', title: 'On the workbench', description: 'A little progress, every day.' },
  { id: 'done', title: 'Made together', description: 'Finished projects worth celebrating.' },
];

export const tasks = [
  { id: 'tool-wall', title: 'Label the tool wall', description: 'Make every screwdriver and clamp easy to find.', category: 'Space', status: 'ready', owner: 'Alex' },
  { id: 'seed-box', title: 'Build a seed swap box', description: 'A small home for seeds and growing notes.', category: 'Woodwork', status: 'ready', owner: 'Jules' },
  { id: 'repair-guide', title: 'Write a repair guide', description: 'Share five fixes for everyday loose parts.', category: 'Learning', status: 'ready', owner: 'Morgan' },
  { id: 'lamp', title: 'Repair the reading lamp', description: 'Test a new switch and tidy the cable.', category: 'Repair', status: 'making', owner: 'Sam' },
  { id: 'noticeboard', title: 'Refresh the noticeboard', description: 'Give upcoming sessions room to breathe.', category: 'Space', status: 'making', owner: 'Kai' },
  { id: 'stool', title: 'Finish the little stool', description: 'Sand the edges and add a coat of oil.', category: 'Woodwork', status: 'done', owner: 'Rae' },
];

export const library = [
  'Plan a project in one page', 'Measure twice, cut once', 'Choose the right fastener',
  'Keep a safe workbench', 'Make a useful sketch', 'Start a repair notebook',
  'Prepare timber for a finish', 'Sharpen a pencil properly', 'Sort reusable materials',
  'Care for hand tools', 'Build a simple jig', 'Join a weekly open session',
  'Write clear assembly notes', 'Choose an indoor finish', 'Read a wiring label',
  'Set up a shared tool kit', 'Make a cardboard prototype', 'Photograph a finished project',
  'Organize a repair afternoon', 'Prepare a materials list', 'Clamp awkward shapes',
  'Sand with the grain', 'Share what you learned', 'Store small components',
  'Ask for a second pair of hands', 'Estimate a weekend project', 'Keep a progress log',
  'Test before the final assembly', 'Clean up for the next maker', 'Celebrate a useful mistake',
];

export function validateProposal(value) {
  const title = typeof value?.title === 'string' ? value.title.trim() : '';
  const email = typeof value?.email === 'string' ? value.email.trim() : '';
  const errors = [];
  if (title.length < 6) errors.push({ field: 'title', message: 'Task title must contain at least 6 characters.' });
  if (title.length > 100) errors.push({ field: 'title', message: 'Task title must contain at most 100 characters.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 160) errors.push({ field: 'email', message: 'Contact email must be a valid email address.' });
  return { title, email, errors };
}
