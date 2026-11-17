// Signing in. There is no password: the bot sends a code by DM to someone it
// already answers, and the code is typed here (src/panel/auth.js).

import { post } from '../api.js';
import { h } from '../dom.js';

export function signIn({ onDone }) {
  const code = h('input', {
    class: 'field',
    id: 'code',
    name: 'code',
    inputmode: 'numeric',
    autocomplete: 'one-time-code',
    placeholder: '0000 0000',
    maxlength: '12',
    'aria-describedby': 'code-says',
  });
  const says = h('p', { id: 'code-says', class: 'muted', role: 'status' }, 'The code works once, for ten minutes.');
  const button = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Sign in');
  const form = h(
    'form',
    {
      onSubmit: async (e) => {
        e.preventDefault();
        if (!code.value.trim()) return code.focus();
        button.disabled = true;
        try {
          await post('/api/sign-in', { code: code.value });
          onDone();
        } catch (err) {
          says.textContent = String(err.message || err);
          says.className = 'error';
          button.disabled = false;
          code.select();
        }
        return undefined;
      },
    },
    h('label', { class: 'label', for: 'code' }, 'The code the bot sent you', code),
    says,
    button,
  );
  const el = h(
    'main',
    { class: 'signin' },
    h('h1', null, 'Sign in to the panel'),
    h(
      'ol',
      null,
      h('li', null, 'Open your DMs with the bot on Bluesky.'),
      h('li', null, 'Send it the word ', h('strong', null, 'panel'), '.'),
      h('li', null, 'Type the code it answers with below.'),
    ),
    form,
    h('p', { class: 'muted' }, 'The bot only answers the accounts it works for, so only they can get a code.'),
  );
  queueMicrotask(() => code.focus());
  return { el };
}
