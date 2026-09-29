const state={category:'All',listings:[],user:null,bookings:[]};
const $=s=>document.querySelector(s);
const money=n=>new Intl.NumberFormat('en-NG',{style:'currency',currency:'NGN',maximumFractionDigits:0}).format(Number(n||0));
const tokenKey='rental-marketplace-token';

async function api(url,options={}) {
  const headers={...(options.body instanceof FormData?{}:{'Content-Type':'application/json'}),...(options.headers||{})};
  const token=localStorage.getItem(tokenKey); if(token) headers.Authorization=`Bearer ${token}`;
  const r=await fetch(url,{...options,headers,body:options.body instanceof FormData?options.body:options.body?JSON.stringify(options.body):undefined});
  const d=await r.json().catch(()=>({})); if(!r.ok) throw new Error(d.error||'Request failed'); return d;
}
function toast(m){const e=$('#toast');e.textContent=m;e.classList.add('show');setTimeout(()=>e.classList.remove('show'),2500)}
function section(name){document.querySelectorAll('.app-section').forEach(x=>x.classList.toggle('active-section',x.id===name));document.querySelectorAll('.nav-btn').forEach(x=>x.classList.toggle('active',x.dataset.section===name))}
function render(){
  const q=($('#search').value||'').toLowerCase(), s=$('#stateFilter').value;
  const items=state.listings.filter(x=>(state.category==='All'||x.category===state.category)&&(!s||x.state===s)&&(`${x.name} ${x.category} ${x.state} ${x.city} ${x.area}`.toLowerCase().includes(q)));
  $('#listing-grid').innerHTML=items.length?items.map(x=>`<article class="listing"><div class="listing-image" style="background-image:url('${encodeURI(x.image)}')"></div><div class="listing-body"><h3>${esc(x.name)}</h3><div class="listing-meta"><span>${esc(x.area)}, ${esc(x.city)}, ${esc(x.state)}</span></div><div class="listing-footer"><span class="price">${money(x.price)}<small>/day</small></span><button class="reserve" data-id="${x.id}">Reserve</button></div></div></article>`).join(''):'<div class="panel">No matching listings found.</div>';
}
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
async function loadLocations(){
  const data=await api('/api/locations');
  document.querySelectorAll('.state-select').forEach(s=>s.innerHTML='<option value="">Select state</option>'+data.states.map(x=>`<option>${esc(x)}</option>`).join(''));
  $('#stateFilter').innerHTML='<option value="">All states</option>'+data.states.map(x=>`<option>${esc(x)}</option>`).join('');
}
async function refresh(){
  try{state.listings=await api(`/api/listings?category=${encodeURIComponent(state.category)}&state=${encodeURIComponent($('#stateFilter').value)}&q=${encodeURIComponent($('#search').value)}`);render()}
  catch(e){toast(e.message)}
}
async function restore(){
  if(!localStorage.getItem(tokenKey)) return;
  try{const r=await api('/api/auth/me');state.user=r.user;$('#logoutBtn').classList.remove('hidden');$('#whoami').textContent=`Signed in as ${r.user.name} (${r.user.role}).`;window.refreshAdminUI?.();await loadBookings()}
  catch{localStorage.removeItem(tokenKey)}
}

async function handlePaymentReturn(){
  const reference=new URLSearchParams(location.search).get('payment_reference');
  if(!reference||!state.user)return;
  try{const r=await api('/api/payments/verify',{method:'POST',body:{reference}});toast(r.paid?'Payment confirmed.':'Payment was not confirmed.');history.replaceState({},document.title,location.pathname)}catch(e){toast(e.message)}
}
async function loadEscrow(){
  if(!state.user)return;
  try{
    const rows=await api('/api/escrow');
    $('#escrowSummary').innerHTML=rows.length
      ? `<h3>Escrow</h3>`+rows.map(e=>`<div class="booking-row"><div><strong>${esc(e.listing_name)}</strong><small>${e.reference} · ${esc(e.status)}</small></div><span>${money(e.amount)}</span></div>`).join('')
      : '<h3>Escrow</h3><p>No escrow transactions yet.</p>';
  }catch(e){toast(e.message)}
}
async function startEscrow(bookingId){
  try{
    const r=await api('/api/escrow/authorize',{method:'POST',body:{bookingId}});
    if(r.payment?.authorization_url){ location.href=r.payment.authorization_url; return; }
    toast(r.message||'Escrow created.');
    await loadEscrow();
  }catch(e){toast(e.message)}
}
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}

async function loadBookings(){
  if(!state.user)return;
  try{state.bookings=await api('/api/bookings');$('#bookingSummary').innerHTML=state.bookings.length?state.bookings.map(b=>`<div class="booking-row"><div><strong>${esc(b.item)}</strong><small>${b.start_date} → ${b.end_date} · ${esc(b.status)}</small></div><span>${money(b.total)}${b.status==='pending'?` <button class="pay-booking" data-id="${b.id}">Pay</button>`:''}</span></div>`).join(''):'<p>No bookings yet.</p>'}
  catch(e){toast(e.message)}
}
async function login(e){e.preventDefault();try{const r=await api('/api/auth/login',{method:'POST',body:Object.fromEntries(new FormData(e.target))});localStorage.setItem(tokenKey,r.token);state.user=r.user;$('#logoutBtn').classList.remove('hidden');$('#whoami').textContent=`Signed in as ${r.user.name} (${r.user.role}).`;window.refreshAdminUI?.();toast('Login successful');section('dashboard');await loadBookings();await loadEscrow()}catch(x){toast(x.message)}}
async function signup(e){e.preventDefault();try{const r=await api('/api/auth/register',{method:'POST',body:Object.fromEntries(new FormData(e.target))});localStorage.setItem(tokenKey,r.token);state.user=r.user;$('#logoutBtn').classList.remove('hidden');$('#whoami').textContent=`Signed in as ${r.user.name} (${r.user.role}).`;window.refreshAdminUI?.();toast('Account created');section('dashboard')}catch(x){toast(x.message)}}
async function listItem(e){e.preventDefault();try{await api('/api/listings',{method:'POST',body:Object.fromEntries(new FormData(e.target))});toast('Listing submitted for review');e.target.reset()}catch(x){toast(x.message)}}
async function upload(e){e.preventDefault();try{const r=await api('/api/uploads',{method:'POST',body:new FormData(e.target)});$('#imageUrl').value=r.url;toast('Image uploaded')}catch(x){toast(x.message)}}
async function reserve(e){const b=e.target.closest('.reserve');if(!b)return;if(!state.user){toast('Please log in before reserving.');return}const startDate=prompt('Start date (YYYY-MM-DD)');const endDate=prompt('End date (YYYY-MM-DD)');if(!startDate||!endDate)return;try{await api('/api/bookings',{method:'POST',body:{listingId:b.dataset.id,startDate,endDate}});toast('Booking request created');await loadBookings();section('dashboard')}catch(x){toast(x.message)}}
$('#bookingSummary').onclick=e=>{const b=e.target.closest('.pay-booking');if(b)startEscrow(b.dataset.id)};
document.addEventListener('DOMContentLoaded',async()=>{document.querySelectorAll('.nav-btn').forEach(b=>b.onclick=()=>section(b.dataset.section));document.querySelectorAll('.filter').forEach(b=>b.onclick=()=>{document.querySelectorAll('.filter').forEach(x=>x.classList.remove('active'));b.classList.add('active');state.category=b.dataset.category;refresh()});$('#search').oninput=refresh;$('#stateFilter').onchange=refresh;$('#listing-grid').onclick=reserve;$('#loginForm').onsubmit=login;$('#signupForm').onsubmit=signup;$('#listing-form').onsubmit=listItem;$('#uploadForm').onsubmit=upload;$('#logoutBtn').onclick=()=>{localStorage.removeItem(tokenKey);location.reload()};try{await loadLocations();await restore();await refresh();await handlePaymentReturn()}catch(e){toast(e.message)}});
