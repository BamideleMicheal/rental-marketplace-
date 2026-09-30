const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const EMAIL_FROM = process.env.EMAIL_FROM || '';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'
  }[c]));
}

async function sendEmail({ to, subject, html, text = '' }) {
  if (!RESEND_API_KEY || !EMAIL_FROM || !to) {
    return { sent: false, skipped: true };
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to: [to],
      subject,
      html,
      text
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    throw new Error(data.message || data.error?.message || 'Email provider request failed.');
  }

  return { sent: true, id: data.id || null };
}

function layout(title, body) {
  return `<!doctype html><html><body style="font-family:Arial,sans-serif;line-height:1.6;color:#222">
    <div style="max-width:620px;margin:auto;padding:24px">
      <h2>Rental Marketplace</h2>
      <h3>${escapeHtml(title)}</h3>
      ${body}
      <hr><small>This is an automated Rental Marketplace notification.</small>
    </div>
  </body></html>`;
}

function welcome(user) {
  return sendEmail({
    to:user.email,
    subject:'Welcome to Rental Marketplace',
    html:layout('Welcome',`<p>Hello ${escapeHtml(user.name)},</p><p>Your Rental Marketplace account has been created successfully.</p>`),
    text:`Hello ${user.name}, your Rental Marketplace account has been created successfully.`
  });
}

function bookingCreated({to,name,item,startDate,endDate,total}) {
  return sendEmail({
    to,
    subject:'Booking request created',
    html:layout('Booking request',`<p>Hello ${escapeHtml(name)},</p><p>Your booking request for <strong>${escapeHtml(item)}</strong> from ${escapeHtml(startDate)} to ${escapeHtml(endDate)} has been created.</p><p>Total: <strong>₦${escapeHtml(total)}</strong></p>`),
    text:`Your booking request for ${item} from ${startDate} to ${endDate} has been created. Total: ₦${total}.`
  });
}

function bookingReceived({to,name,item,startDate,endDate,total}) {
  return sendEmail({
    to,
    subject:'New booking request',
    html:layout('New booking request',`<p>Hello ${escapeHtml(name)},</p><p>You received a booking request for <strong>${escapeHtml(item)}</strong> from ${escapeHtml(startDate)} to ${escapeHtml(endDate)}.</p><p>Total: <strong>₦${escapeHtml(total)}</strong></p>`),
    text:`You received a booking request for ${item} from ${startDate} to ${endDate}. Total: ₦${total}.`
  });
}

function paymentConfirmed({to,name,item,total}) {
  return sendEmail({
    to,
    subject:'Payment confirmed',
    html:layout('Payment confirmed',`<p>Hello ${escapeHtml(name)},</p><p>Payment for <strong>${escapeHtml(item)}</strong> has been confirmed and the escrow record is funded.</p><p>Amount: <strong>₦${escapeHtml(total)}</strong></p>`),
    text:`Payment for ${item} has been confirmed and escrow is funded. Amount: ₦${total}.`
  });
}

function disputeCreated({to,name,item,reason}) {
  return sendEmail({
    to,
    subject:'Booking dispute opened',
    html:layout('Dispute opened',`<p>Hello ${escapeHtml(name)},</p><p>A dispute has been opened for <strong>${escapeHtml(item)}</strong>.</p><p>Reason: ${escapeHtml(reason)}</p>`),
    text:`A dispute has been opened for ${item}. Reason: ${reason}.`
  });
}

function listingStatus({to,name,item,status}) {
  return sendEmail({
    to,
    subject:`Listing ${status}`,
    html:layout('Listing update',`<p>Hello ${escapeHtml(name)},</p><p>Your listing <strong>${escapeHtml(item)}</strong> is now <strong>${escapeHtml(status)}</strong>.</p>`),
    text:`Your listing ${item} is now ${status}.`
  });
}

function payoutStatus({to,name,amount,status}) {
  return sendEmail({
    to,
    subject:'Payout status updated',
    html:layout('Payout update',`<p>Hello ${escapeHtml(name)},</p><p>Your payout of <strong>₦${escapeHtml(amount)}</strong> is now <strong>${escapeHtml(status)}</strong>.</p>`),
    text:`Your payout of ₦${amount} is now ${status}.`
  });
}

function rentalStartReminder({to,name,item,startDate,endDate}) {
  return sendEmail({
    to,
    subject:'Rental starts today',
    html:layout('Rental starts today',`<p>Hello ${escapeHtml(name)},</p><p>Your rental for <strong>${escapeHtml(item)}</strong> starts today.</p><p>Rental period: ${escapeHtml(startDate)} to ${escapeHtml(endDate)}.</p>`),
    text:`Your rental for ${item} starts today. Rental period: ${startDate} to ${endDate}.`
  });
}

function returnReminder({to,name,item,endDate}) {
  return sendEmail({
    to,
    subject:'Rental return reminder',
    html:layout('Return reminder',`<p>Hello ${escapeHtml(name)},</p><p>This is a reminder that <strong>${escapeHtml(item)}</strong> is due for return tomorrow.</p><p>Return date: ${escapeHtml(endDate)}.</p>`),
    text:`Reminder: ${item} is due for return tomorrow, ${endDate}.`
  });
}

module.exports = {
  sendEmail,
  welcome,
  bookingCreated,
  bookingReceived,
  paymentConfirmed,
  disputeCreated,
  listingStatus,
  payoutStatus,
  rentalStartReminder,
  returnReminder
};
