/* ===== CART STATE ===== */
let cart = [];

function fmt(n) {
  return n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

function addToCart(name, price) {
  const existing = cart.find(i => i.name === name);
  if (existing) {
    existing.qty += 1;
  } else {
    cart.push({ name, price, qty: 1 });
  }
  renderCart();
  openCart();
  showNotif(`${name} ajouté au panier`);
}

function removeFromCart(name) {
  cart = cart.filter(i => i.name !== name);
  renderCart();
}

function renderCart() {
  const container = document.getElementById('cartItems');
  const totalEl = document.getElementById('cartTotal');
  const countEl = document.querySelector('.cart-count');

  if (cart.length === 0) {
    container.innerHTML = '<p class="cart__empty">Votre panier est vide.</p>';
    totalEl.textContent = '0 €';
    countEl.textContent = '0';
    return;
  }

  const total = cart.reduce((sum, i) => sum + i.price * i.qty, 0);
  countEl.textContent = cart.reduce((sum, i) => sum + i.qty, 0);
  totalEl.textContent = fmt(total);

  container.innerHTML = cart.map(item => `
    <div class="cart-item">
      <div>
        <div class="cart-item__name">${item.name} ${item.qty > 1 ? `×${item.qty}` : ''}</div>
        <div class="cart-item__price">${fmt(item.price * item.qty)}</div>
      </div>
      <button class="cart-item__remove" onclick="removeFromCart('${item.name.replace(/'/g, "\\'")}')">✕</button>
    </div>
  `).join('');
}

function openCart() {
  document.getElementById('cart').classList.add('open');
  document.getElementById('cartOverlay').classList.add('open');
}

function closeCart() {
  document.getElementById('cart').classList.remove('open');
  document.getElementById('cartOverlay').classList.remove('open');
}

document.querySelector('.nav__cart').addEventListener('click', openCart);

/* ===== NOTIFICATION ===== */
function showNotif(msg) {
  const el = document.getElementById('notif');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2500);
}

/* ===== FORM ===== */
function handleForm(e) {
  e.preventDefault();
  showNotif('Message envoyé — merci !');
  e.target.reset();
}

/* ===== SCROLL REVEAL ===== */
const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.style.opacity = '1';
      entry.target.style.transform = 'translateY(0)';
    }
  });
}, { threshold: 0.12 });

document.querySelectorAll('.feature, .step, .specs__row, .buy__info').forEach(el => {
  el.style.opacity = '0';
  el.style.transform = 'translateY(28px)';
  el.style.transition = 'opacity 0.7s ease, transform 0.7s ease';
  observer.observe(el);
});
