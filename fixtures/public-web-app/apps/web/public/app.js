const main = document.querySelector('main');
const panel = document.querySelector('#library-panel');
const libraryButton = document.querySelector('.library-button');
const libraryList = document.querySelector('.library-list');
const scrollReadout = document.querySelector('[data-testid="library-scroll-readout"]');
let board;
let activeGuide = null;

function element(tag, attributes = {}, text = '') {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  node.textContent = text;
  return node;
}

function setLibrary(open) {
  panel.dataset.open = String(open);
  panel.setAttribute('aria-hidden', String(!open));
  panel.inert = !open;
  libraryButton.setAttribute('aria-expanded', String(open));
  document.body.classList.toggle('library-open', open);
  if (open) panel.querySelector('.icon-button').focus({ preventScroll: true });
  else libraryButton.focus({ preventScroll: true });
}

libraryButton.addEventListener('click', () => setLibrary(true));
panel.querySelector('.icon-button').addEventListener('click', () => setLibrary(false));
document.querySelector('.drawer-backdrop').addEventListener('click', () => setLibrary(false));
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && panel.dataset.open === 'true') setLibrary(false); });
libraryList.addEventListener('scroll', () => {
  const top = Math.round(libraryList.scrollTop);
  scrollReadout.dataset.scrollTop = String(top);
  scrollReadout.dataset.scrolled = String(top > 0);
  scrollReadout.value = `Panel scroll ${top} px`;
});

function renderLibrary() {
  libraryList.replaceChildren();
  board.library.forEach((title, index) => {
    const item = element('button', { type: 'button', class: 'guide', 'aria-pressed': String(activeGuide === index) });
    item.append(element('span', { class: 'guide-number' }, String(index + 1).padStart(2, '0')), element('span', {}, title));
    item.addEventListener('click', () => {
      activeGuide = index;
      libraryList.querySelectorAll('button').forEach((button, position) => button.setAttribute('aria-pressed', String(position === index)));
      item.querySelector('span:last-child').textContent = `${title} · saved for later`;
    });
    libraryList.append(item);
  });
}

function pageIntro(eyebrow, title, description) {
  const header = element('header', { class: 'page-intro' });
  header.append(element('p', { class: 'eyebrow' }, eyebrow), element('h1', {}, title), element('p', { class: 'description' }, description));
  return header;
}

function renderBoard() {
  main.replaceChildren(pageIntro('Make room for good ideas', 'Workshop board', 'Small projects. Shared tools. Something useful at the end.'));
  const summary = element('div', { class: 'board-summary' });
  summary.append(element('span', { class: 'live-dot', 'aria-hidden': 'true' }), element('p', {}, `${board.tasks.length} projects on the board`), element('span', { class: 'summary-note' }, 'Local demo'));
  main.append(summary);
  for (const column of board.columns) {
    const section = element('section', { class: 'board-column', 'aria-label': column.title });
    const heading = element('div', { class: 'column-heading' });
    const tasks = board.tasks.filter((task) => task.status === column.id);
    heading.append(element('h2', {}, column.title), element('span', { class: 'count' }, String(tasks.length)));
    section.append(heading, element('p', { class: 'column-description' }, column.description));
    const cards = element('div', { class: 'cards' });
    for (const task of tasks) {
      const card = element('article', { class: 'task-card' });
      card.append(element('span', { class: 'category' }, task.category), element('h3', {}, task.title), element('p', {}, task.description));
      const footer = element('div', { class: 'card-footer' });
      footer.append(element('span', { class: 'owner' }, `${task.owner.slice(0, 1)} · ${task.owner}`));
      const action = element('button', { type: 'button', class: 'task-action', 'aria-label': `${task.status === 'done' ? 'Reopen' : 'Complete'} ${task.title}` }, task.status === 'done' ? 'Reopen' : 'Mark done');
      action.addEventListener('click', () => { task.status = task.status === 'done' ? 'ready' : 'done'; renderBoard(); });
      footer.append(action);
      card.append(footer);
      cards.append(card);
    }
    section.append(cards);
    main.append(section);
  }
}

function renderProposal() {
  main.replaceChildren(pageIntro('Start with a small idea', 'Propose a task', 'Tell the workshop what you would like to make or repair.'));
  const form = element('form', { class: 'proposal-form', novalidate: '' });
  const titleLabel = element('label', { for: 'task-title' }, 'Task title');
  const title = element('input', { id: 'task-title', name: 'title', required: '', minlength: '6', maxlength: '100', autocomplete: 'off', placeholder: 'Build a small bookshelf' });
  const emailLabel = element('label', { for: 'contact-email' }, 'Contact email');
  const email = element('input', { id: 'contact-email', name: 'email', type: 'email', required: '', maxlength: '160', autocomplete: 'off', placeholder: 'maker@example.invalid' });
  const hint = element('p', { class: 'form-hint' }, 'Use synthetic details. This example keeps new tasks in this tab.');
  const feedback = element('div', { 'data-testid': 'proposal-feedback', class: 'proposal-feedback', hidden: '' });
  const submit = element('button', { class: 'primary-button', type: 'submit' }, 'Add task');
  form.append(titleLabel, title, emailLabel, email, hint, feedback, submit);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;
    title.removeAttribute('aria-invalid');
    email.removeAttribute('aria-invalid');
    try {
      const response = await fetch('/api/proposals', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: title.value, email: email.value }) });
      const result = await response.json();
      if (response.status === 422) {
        feedback.setAttribute('role', 'alert');
        feedback.dataset.tone = result.feedback.tone;
        feedback.replaceChildren(element('h2', {}, result.feedback.title), element('p', {}, result.feedback.message));
        const list = element('ul');
        for (const error of result.errors) {
          list.append(element('li', {}, error.message));
          form.elements.namedItem(error.field).setAttribute('aria-invalid', 'true');
        }
        feedback.append(list);
        feedback.hidden = false;
      } else if (response.ok) {
        board.tasks.push(result.task);
        navigate('/board');
      } else throw new Error('Proposal unavailable');
    } catch {
      feedback.setAttribute('role', 'alert');
      feedback.textContent = 'The task could not be checked. Try again.';
      feedback.hidden = false;
    } finally { submit.disabled = false; }
  });
  main.append(form, element('p', { class: 'privacy-note' }, 'No accounts. No external services. Just a place to try an idea.'));
}

function renderRoute() {
  const route = location.pathname === '/proposals' ? '/proposals' : '/board';
  document.querySelectorAll('.main-nav a').forEach((link) => {
    if (link.getAttribute('href') === route) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  if (route === '/proposals') renderProposal();
  else renderBoard();
}

function navigate(path) {
  history.pushState({}, '', path);
  renderRoute();
  window.scrollTo({ top: 0, behavior: 'instant' });
}
document.addEventListener('click', (event) => {
  const link = event.target.closest('a[data-route]');
  if (!link || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(link.getAttribute('href'));
});
window.addEventListener('popstate', renderRoute);

try {
  const response = await fetch('/api/board');
  if (!response.ok) throw new Error('Board unavailable');
  board = await response.json();
  renderLibrary();
  renderRoute();
  document.body.dataset.ready = 'true';
} catch { main.replaceChildren(element('p', { role: 'alert' }, 'The workshop could not open. Refresh to try again.')); }
