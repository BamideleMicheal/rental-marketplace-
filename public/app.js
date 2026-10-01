const state={category:'All',listings:[],user:null,bookings:[],cart:[]};
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
  $('#listing-grid').innerHTML=items.length?items.map(x=>`<article class="listing"><div class="listing-image" style="background-image:url('${encodeURI(x.image)}')"></div><div class="listing-body"><h3>${esc(x.name)}</h3><div class="listing-meta"><span>${esc(x.area)}, ${esc(x.city)}, ${esc(x.state)}</span></div><div class="listing-footer"><span class="price">${money(x.price)}<small>/day</small></span><button class="add-cart" data-id="${x.id}">Add to cart</button></div></div></article>`).join(''):'<div class="panel">No matching listings found.</div>';
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
  try{const r=await api('/api/auth/me');state.user=r.user;$('#logoutBtn').classList.remove('hidden');$('#whoami').textContent=`Signed in as ${r.user.name} (${r.user.role}).`;window.refreshAdminUI?.();await loadBookings();await loadVerification()}
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

async function loadCart(){
  if(!state.user){state.cart=[];updateCartBadge();return}
  try{state.cart=await api('/api/cart');updateCartBadge();renderCart()}catch(e){toast(e.message)}
}
function updateCartBadge(){const n=$('#cartCount');if(n)n.textContent=state.cart.length}
function renderCart(){
  const el=$('#cartItems');if(!el)return;
  if(!state.cart.length){el.innerHTML='<p>Your cart is empty. Add items from Explore.</p>';return}
  el.innerHTML=state.cart.map(c=>`<div class="cart-item">
    <img src="${esc(c.image)}" alt="">
    <div class="cart-item-main"><h3>${esc(c.name)}</h3><small>${money(c.price)}/day · ${esc(c.area)}, ${esc(c.city)}</small>
    <div class="cart-fields"><label>Start <input type="date" class="cart-start" data-id="${c.id}" value="${c.start_date}"></label>
    <label>End <input type="date" class="cart-end" data-id="${c.id}" value="${c.end_date}"></label>
    <label>Delivery <select class="cart-delivery" data-id="${c.id}"><option value="self-pickup" ${c.delivery_method==='self-pickup'?'selected':''}>Self pickup</option><option value="delivery-return" ${c.delivery_method==='delivery-return'?'selected':''}>Delivery + return</option><option value="delivery-only" ${c.delivery_method==='delivery-only'?'selected':''}>Delivery only</option></select></label>
    <label class="cart-address">Address <input class="cart-address-input" data-id="${c.id}" value="${esc(c.delivery_address||'')}" placeholder="Delivery address"></label></div>
    <div class="cart-actions"><button class="save-cart" data-id="${c.id}">Update</button><button class="remove-cart ghost" data-id="${c.id}">Remove</button></div></div></div>`).join('');
}
async function loadReputation(){
  if(!state.user)return;
  try{
    const r=await api('/api/users/'+state.user.id+'/reviews');
    const s=r.summary||{average_rating:0,review_count:0};
    $('#reputationContent').innerHTML=
      '<strong>★ '+esc(s.average_rating||0)+'/5</strong> · '+esc(s.review_count||0)+' verified review(s)' +
      (r.reviews?.length ? '<div class="review-list">'+r.reviews.slice(0,5).map(v=>'<div class="review-card"><div><strong>'+esc(v.reviewer_name)+'</strong> · '+('★'.repeat(Number(v.rating)))+'</div><small>'+esc(v.listing_name)+' · '+String(v.created_at).slice(0,10)+'</small><p>'+esc(v.comment||'No written comment.')+'</p></div>').join('')+'</div>' : '<p>No reviews yet.</p>');
  }catch(e){toast(e.message)}
}
async function openReview(bookingId){
  try{
    const r=await api('/api/bookings/'+bookingId+'/review');
    const b=state.bookings.find(x=>String(x.id)===String(bookingId));
    if(!b)return;
    if(r.review){toast('You already reviewed this rental.');return;}
    $('#reviewPanel').classList.remove('hidden');
    $('#reviewForm [name="bookingId"]').value=bookingId;
    $('#reviewItem').textContent='Rental: '+b.item+' · '+b.start_date+' → '+b.end_date;
    section('dashboard');
    window.scrollTo({top:document.querySelector('#reviewPanel').offsetTop,behavior:'smooth'});
  }catch(e){toast(e.message)}
}
async function submitReview(e){
  e.preventDefault();
  try{
    const data=Object.fromEntries(new FormData(e.target));
    await api('/api/reviews',{method:'POST',body:{bookingId:Number(data.bookingId),rating:Number(data.rating),comment:data.comment}});
    e.target.reset();$('#reviewPanel').classList.add('hidden');toast('Review submitted');await loadBookings();await loadReputation();
  }catch(x){toast(x.message)}
}
async function loadRenterReviews(userId){
  try{
    const r=await api('/api/users/'+userId+'/reviews');
    const summary=r.summary||{average_rating:0,review_count:0};
    $('#reviewSummary').innerHTML='<h3>Renter reputation</h3><div class="review-rating"><strong>'+esc(summary.average_rating)+'</strong> / 5 · '+esc(summary.review_count)+' review(s)</div>';
    $('#renterReviews').innerHTML=r.reviews.length?'<div class="review-list">'+r.reviews.map(v=>'<article class="review-card"><div class="review-stars">'+('★'.repeat(Number(v.rating)))+('☆'.repeat(5-Number(v.rating)))+'</div><strong>'+esc(v.reviewer_name)+'</strong><small>'+esc(v.listing_name)+' · '+new Date(v.created_at).toLocaleDateString()+'</small><p>'+esc(v.comment||'No written comment.')+'</p></article>').join('')+'</div>':'<p>No reviews yet.</p>';
  }catch(e){$('#reviewSummary').innerHTML='<h3>Renter reputation</h3><p>Reviews unavailable.</p>';}
}
async function loadBookingReview(bookingId){
  try{return (await api('/api/bookings/'+bookingId+'/review')).review}catch{return null}
}
async function submitReview(bookingId){
  const rating=prompt('Rating from 1 to 5');
  if(rating===null)return;
  const comment=prompt('Write your review comment (optional)')||'';
  try{await api('/api/reviews',{method:'POST',body:{bookingId,rating:Number(rating),comment}});toast('Review submitted');await loadBookings()}catch(e){toast(e.message)}
}

async function loadVerification(){
  if(!state.user)return;
  try{
    const r=await api('/api/verification/me');
    const p=r.profile||{};
    const form=$('#profileForm');
    if(form){for(const [name,key] of [['firstName','first_name'],['middleName','middle_name'],['surname','surname'],['dateOfBirth','date_of_birth'],['gender','gender'],['phone','phone'],['occupation','occupation'],['residentialAddress','residential_address'],['lga','lga'],['state','state']]){if(form.elements[name])form.elements[name].value=p[key]||'';}}
    $('#verificationStatus').innerHTML='<p><strong>Identity:</strong> '+esc(p.verification_status||'not submitted')+'</p><p><strong>Guarantors:</strong> '+esc(r.guarantors?.length||0)+' · <strong>Item checks:</strong> '+esc(r.itemVerifications?.length||0)+'</p>';
  }catch(e){toast(e.message)}
}
async function saveProfile(e){e.preventDefault();try{await api('/api/profile',{method:'PUT',body:Object.fromEntries(new FormData(e.target))});toast('Personal details saved');await loadVerification()}catch(x){toast(x.message)}}
async function submitIdentity(e){e.preventDefault();try{await api('/api/verification/identity',{method:'POST',body:new FormData(e.target)});e.target.reset();toast('Identity verification submitted');await loadVerification()}catch(x){toast(x.message)}}
async function submitProfilePhoto(e){e.preventDefault();try{await api('/api/profile/photo',{method:'POST',body:new FormData(e.target)});e.target.reset();toast('Profile photograph uploaded');await loadVerification()}catch(x){toast(x.message)}}
async function submitGuarantor(e){e.preventDefault();try{const fd=new FormData(e.target);await api('/api/guarantors',{method:'POST',body:fd});e.target.reset();toast('Guarantor submitted');await loadVerification()}catch(x){toast(x.message)}}
async function submitOwnership(e){e.preventDefault();try{const fd=new FormData(e.target), id=fd.get('listingId');fd.delete('listingId');await api('/api/listings/'+encodeURIComponent(id)+'/ownership-verification',{method:'POST',body:fd});e.target.reset();toast('Ownership verification submitted for admin review')}catch(x){toast(x.message)}}
\nasync function loadBookings(){
  if(!state.user)return;
  try{state.bookings=await api('/api/bookings');$('#bookingSummary').innerHTML=state.bookings.length?state.bookings.map(b=>`<div class="booking-row"><div><strong>${esc(b.item)}</strong><small>${b.start_date} → ${b.end_date} · ${esc(b.status)}</small></div><span>${money(b.total)}${b.status==='pending'?` <button class="pay-booking" data-id="${b.id}">Pay</button>`:''}${b.status==='completed'?` <button class="review-booking" data-id="${b.id}">Review renter</button>`:''}</span></div>`).join(''):'<p>No bookings yet.</p>'}
  catch(e){toast(e.message)}
}
async function login(e){e.preventDefault();try{const r=await api('/api/auth/login',{method:'POST',body:Object.fromEntries(new FormData(e.target))});localStorage.setItem(tokenKey,r.token);state.user=r.user;$('#logoutBtn').classList.remove('hidden');$('#whoami').textContent=`Signed in as ${r.user.name} (${r.user.role}).`;window.refreshAdminUI?.();toast('Login successful');section('dashboard');await loadBookings();await loadCart();await loadEscrow();await loadReputation();await loadVerification()}catch(x){toast(x.message)}}
async function signup(e){e.preventDefault();try{const r=await api('/api/auth/register',{method:'POST',body:Object.fromEntries(new FormData(e.target))});localStorage.setItem(tokenKey,r.token);state.user=r.user;$('#logoutBtn').classList.remove('hidden');$('#whoami').textContent=`Signed in as ${r.user.name} (${r.user.role}).`;window.refreshAdminUI?.();toast('Account created');section('dashboard')}catch(x){toast(x.message)}}
async function listItem(e){e.preventDefault();try{await api('/api/listings',{method:'POST',body:Object.fromEntries(new FormData(e.target))});toast('Listing submitted for review');e.target.reset()}catch(x){toast(x.message)}}
async function upload(e){e.preventDefault();try{const r=await api('/api/uploads',{method:'POST',body:new FormData(e.target)});$('#imageUrl').value=r.url;toast('Image uploaded')}catch(x){toast(x.message)}}
async function addToCart(e){const b=e.target.closest('.add-cart');if(!b)return;if(!state.user){toast('Please log in before reserving.');return}const startDate=prompt('Start date (YYYY-MM-DD)');const endDate=prompt('End date (YYYY-MM-DD)');if(!startDate||!endDate)return;const deliveryMethod=(prompt('Delivery: self-pickup, delivery-return, or delivery-only','self-pickup')||'self-pickup').trim();let deliveryAddress='';if(deliveryMethod!=='self-pickup')deliveryAddress=prompt('Delivery address')||'';try{await api('/api/cart',{method:'POST',body:{listingId:b.dataset.id,startDate,endDate,deliveryMethod,deliveryAddress}});toast('Added to cart');await loadCart()}catch(x){toast(x.message)}}
$('#bookingSummary').onclick=e=>{const b=e.target.closest('.pay-booking');if(b)startEscrow(b.dataset.id);const r=e.target.closest('.review-booking');if(r)openReview(r.dataset.id)};
document.addEventListener('DOMContentLoaded',async()=>{document.querySelectorAll('.nav-btn').forEach(b=>b.onclick=()=>section(b.dataset.section));$('#cartNav').onclick=()=>{section('cart');loadCart()};$('#cartItems').onclick=cartActions;$('#cartCheckout').onclick=checkoutCart;document.querySelectorAll('.filter').forEach(b=>b.onclick=()=>{document.querySelectorAll('.filter').forEach(x=>x.classList.remove('active'));b.classList.add('active');state.category=b.dataset.category;refresh()});$('#search').oninput=refresh;$('#stateFilter').onchange=refresh;$('#listing-grid').onclick=addToCart;$('#loginForm').onsubmit=login;$('#reviewForm').onsubmit=submitReview;$('#signupForm').onsubmit=signup;$('#listing-form').onsubmit=listItem;$('#uploadForm').onsubmit=upload;$('#profileForm').onsubmit=saveProfile;$('#identityForm').onsubmit=submitIdentity;$('#guarantorForm').onsubmit=submitGuarantor;$('#profilePhotoForm').onsubmit=submitProfilePhoto;$('#ownershipForm').onsubmit=submitOwnership;$('#logoutBtn').onclick=()=>{localStorage.removeItem(tokenKey);location.reload()};try{await loadLocations();await restore();await refresh();await handlePaymentReturn()}catch(e){toast(e.message)}});

async function cartActions(e){
  const save=e.target.closest('.save-cart'), remove=e.target.closest('.remove-cart');
  if(remove){try{await api('/api/cart/'+remove.dataset.id,{method:'DELETE'});await loadCart()}catch(x){toast(x.message)}return}
  if(save){const id=save.dataset.id;const start=document.querySelector('.cart-start[data-id="'+id+'"]').value;const end=document.querySelector('.cart-end[data-id="'+id+'"]').value;const dm=document.querySelector('.cart-delivery[data-id="'+id+'"]').value;const da=document.querySelector('.cart-address-input[data-id="'+id+'"]').value;try{await api('/api/cart/'+id,{method:'PUT',body:{startDate:start,endDate:end,deliveryMethod:dm,deliveryAddress:da}});toast('Cart item updated');await loadCart()}catch(x){toast(x.message)}}}
async function checkoutCart(){try{const r=await api('/api/cart/checkout',{method:'POST'});toast(r.message||'Bookings created');await loadCart();await loadBookings();section('dashboard')}catch(x){toast(x.message)}}
