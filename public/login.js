/**
 * OpenTenders — Login
 */
const form = document.getElementById('loginForm');
const errorEl = document.getElementById('loginError');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.hidden = true;

  const username = form.username.value.trim();
  const password = form.password.value;

  if (!username || !password) {
    showError('Please enter username and password.');
    return;
  }

  const btn = form.querySelector('button');
  btn.disabled = true;
  btn.textContent = 'Signing in...';

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();

    if (!res.ok || !data.ok) {
      showError(data.error || 'Invalid credentials');
      return;
    }

    sessionStorage.setItem('ot_session', '1');
    window.location.href = '/';
  } catch (err) {
    showError('Connection failed. Please try again.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
});

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.hidden = false;
}
