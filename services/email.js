const BREVO_API_KEY = process.env.BREVO_API_KEY;
const SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || 'noreply@finly.app';
const SENDER_NAME = 'Finly';

async function sendEmail(to, subject, htmlContent) {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
            'api-key': BREVO_API_KEY,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        },
        body: JSON.stringify({
            sender: { name: SENDER_NAME, email: SENDER_EMAIL },
            to: [{ email: to }],
            subject,
            htmlContent,
        }),
    });

    if (!res.ok) {
        const error = await res.text();
        throw new Error(`Brevo email failed: ${res.status} - ${error}`);
    }
}

function otpEmailHTML(code, type) {
    let title, message;
    if (type === 'signup') {
        title = 'Verify Your Email';
        message = 'Welcome to Finly! Enter this code to verify your email and activate your account.';
    } else if (type === 'login') {
        title = 'Verify Your Login';
        message = 'Enter this code to complete sign in to your account.';
    } else {
        title = 'Reset Your Password';
        message = 'You requested a password reset. Enter this code to set your new password.';
    }

    return `
    <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:480px;margin:0 auto;padding:40px 20px;">
        <style>@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}.anim{animation:fadeIn 0.4s ease-out;}</style>
        <div class="anim" style="text-align:center;margin-bottom:30px;">
            <div style="width:56px;height:56px;background:linear-gradient(135deg,#6366f1,#06b6d4);border-radius:16px;display:inline-flex;align-items:center;justify-content:center;color:#fff;font-size:24px;font-weight:bold;">F</div>
            <h1 style="color:#1a1a2e;margin:12px 0 4px;font-size:22px;">${title}</h1>
            <p style="color:#6b7280;margin:0;font-size:14px;">${message}</p>
        </div>
        <div class="anim" style="background:linear-gradient(135deg,#f8f9fa,#f1f5f9);border-radius:12px;padding:24px;text-align:center;margin-bottom:24px;box-shadow:0 2px 8px rgba(0,0,0,0.04);">
            <div style="font-size:36px;font-weight:bold;letter-spacing:8px;color:#6366f1;">${code}</div>
            <p style="color:#9ca3af;font-size:12px;margin:12px 0 0;">This code expires in 5 minutes</p>
        </div>
        <p style="color:#9ca3af;font-size:12px;text-align:center;">If you didn't request this, please ignore this email.</p>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;"/>
        <p style="color:#d1d5db;font-size:11px;text-align:center;">© Finly — Your Personal Finance Companion</p>
    </div>`;
}

function welcomeEmailHTML(name) {
    return `
    <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:480px;margin:0 auto;padding:40px 20px;">
        <style>@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}.anim{animation:fadeIn 0.4s ease-out;}</style>
        <div class="anim" style="text-align:center;margin-bottom:30px;">
            <div style="width:56px;height:56px;background:linear-gradient(135deg,#6366f1,#06b6d4);border-radius:16px;display:inline-flex;align-items:center;justify-content:center;color:#fff;font-size:24px;font-weight:bold;">F</div>
            <h1 style="color:#1a1a2e;margin:12px 0 4px;font-size:22px;">Welcome to Finly! 🎉</h1>
            <p style="color:#6b7280;margin:0;font-size:14px;">Hi ${name}, your account is ready.</p>
        </div>
        <div class="anim" style="background:linear-gradient(135deg,#f8f9fa,#f1f5f9);border-radius:12px;padding:24px;margin-bottom:24px;box-shadow:0 2px 8px rgba(0,0,0,0.04);">
            <h3 style="color:#1a1a2e;margin:0 0 12px;">Get started:</h3>
            <ul style="color:#4b5563;padding-left:20px;margin:0;line-height:2;">
                <li>💰 Track your income &amp; expenses</li>
                <li>📊 View spending insights &amp; charts</li>
                <li>🎯 Set budgets for each category</li>
                <li>📅 Calendar view of your finances</li>
            </ul>
        </div>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;"/>
        <p style="color:#d1d5db;font-size:11px;text-align:center;">© Finly — Your Personal Finance Companion</p>
    </div>`;
}

function loginAlertHTML(deviceInfo, ip, isNewDevice) {
    const title = isNewDevice ? '🔔 New Device Login' : 'Login Notification';
    const message = isNewDevice
        ? 'Your Finly account was accessed from a new device.'
        : 'Your Finly account was just signed into.';

    return `
    <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:480px;margin:0 auto;padding:40px 20px;">
        <style>@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}.anim{animation:fadeIn 0.4s ease-out;}</style>
        <div class="anim" style="text-align:center;margin-bottom:30px;">
            <div style="width:56px;height:56px;background:linear-gradient(135deg,#6366f1,#06b6d4);border-radius:16px;display:inline-flex;align-items:center;justify-content:center;color:#fff;font-size:24px;font-weight:bold;">F</div>
            <h1 style="color:#1a1a2e;margin:12px 0 4px;font-size:22px;">${title}</h1>
            <p style="color:#6b7280;margin:0;font-size:14px;">${message}</p>
        </div>
        <div class="anim" style="background:${isNewDevice ? '#fef2f2' : '#f8f9fa'};border-radius:12px;padding:20px;margin-bottom:24px;box-shadow:0 2px 8px rgba(0,0,0,0.04);">
            <p style="margin:4px 0;color:#4b5563;font-size:13px;"><strong>Device:</strong> ${deviceInfo}</p>
            <p style="margin:4px 0;color:#4b5563;font-size:13px;"><strong>IP:</strong> ${ip || 'Unknown'}</p>
            <p style="margin:4px 0;color:#4b5563;font-size:13px;"><strong>Time:</strong> ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</p>
        </div>
        ${isNewDevice ? '<p style="color:#ef4444;font-size:13px;text-align:center;font-weight:500;">If this wasn\'t you, please reset your password immediately.</p>' : ''}
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;"/>
        <p style="color:#d1d5db;font-size:11px;text-align:center;">© Finly — Your Personal Finance Companion</p>
    </div>`;
}

export async function sendOTP(email, code, type) {
    const subjects = { signup: 'Finly — Verify Your Email', login: 'Finly — Verify Your Login', reset: 'Finly — Password Reset Code' };
    const subject = subjects[type] || subjects.reset;
    try {
        await sendEmail(email, subject, otpEmailHTML(code, type));
        console.log(`📧 OTP sent to ${email} (${type})`);
    } catch (err) {
        console.error('Email send error:', err);
        throw new Error('Failed to send email');
    }
}

export async function sendWelcomeEmail(email, name) {
    try {
        await sendEmail(email, 'Welcome to Finly! 🎉', welcomeEmailHTML(name));
        console.log(`📧 Welcome email sent to ${email}`);
    } catch (err) {
        console.error('Welcome email error:', err);
        // Don't throw — welcome email is not critical
    }
}

export async function sendLoginAlert(email, deviceInfo, ip, isNewDevice) {
    try {
        await sendEmail(email, isNewDevice ? 'Finly — New Device Login Alert 🔔' : 'Finly — Login Notification', loginAlertHTML(deviceInfo, ip, isNewDevice));
        console.log(`📧 Login alert sent to ${email}${isNewDevice ? ' (NEW DEVICE)' : ''}`);
    } catch (err) {
        console.error('Login alert email error:', err);
        // Don't throw — alerts are not critical
    }
}

function budgetAlertEmailHTML(budgetName, percentage, amount, spent) {
    const is100 = percentage >= 100;
    const title = is100 ? 'Budget limit reached' : 'Budget alert — 90% used';
    const pctColor = is100 ? '#dc2626' : '#d97706';
    return `
    <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:480px;margin:0 auto;padding:40px 20px;">
        <style>@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}.anim{animation:fadeIn 0.4s ease-out;}@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.85}}.pct{animation:pulse 1.5s ease-in-out infinite;}</style>
        <div class="anim" style="text-align:center;margin-bottom:30px;">
            <div style="width:56px;height:56px;background:linear-gradient(135deg,#6366f1,#06b6d4);border-radius:16px;display:inline-flex;align-items:center;justify-content:center;color:#fff;font-size:24px;font-weight:bold;">F</div>
            <h1 style="color:#1a1a2e;margin:12px 0 4px;font-size:22px;">${title}</h1>
            <p style="color:#6b7280;margin:0;font-size:14px;">Your budget usage has crossed the threshold.</p>
        </div>
        <div class="anim" style="background:linear-gradient(135deg,#f8f9fa,#f1f5f9);border-radius:12px;padding:24px;margin-bottom:24px;box-shadow:0 2px 8px rgba(0,0,0,0.04);">
            <p style="color:#1a1a2e;font-size:16px;font-weight:600;margin:0 0 12px;">${budgetName}</p>
            <p class="pct" style="font-size:42px;font-weight:800;margin:0;color:${pctColor};line-height:1.2;">${Math.round(percentage)}%</p>
            <p style="color:#6b7280;font-size:14px;margin:12px 0 0;">Spent: ${typeof spent === 'number' ? spent.toLocaleString('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }) : spent} of ${typeof amount === 'number' ? amount.toLocaleString('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }) : amount} budget</p>
        </div>
        <p style="color:#9ca3af;font-size:12px;text-align:center;">View your Budget page in Finly to adjust or track spending.</p>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;"/>
        <p style="color:#d1d5db;font-size:11px;text-align:center;">© Finly — Your Personal Finance Companion</p>
    </div>`;
}

export async function sendBudgetAlert(email, budgetName, percentage, amount, spent) {
    try {
        const subject = percentage >= 100
            ? `Finly — Budget limit reached: ${budgetName}`
            : `Finly — Budget alert (90%): ${budgetName}`;
        await sendEmail(email, subject, budgetAlertEmailHTML(budgetName, percentage, amount, spent));
        console.log(`📧 Budget alert sent to ${email} for ${budgetName} (${Math.round(percentage)}%)`);
    } catch (err) {
        console.error('Budget alert email error:', err);
    }
}

function budgetAlertConsolidatedEmailHTML(items) {
    const formatMoney = (n) => typeof n === 'number' ? n.toLocaleString('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }) : n;
    const rows = items.map(({ budgetName, pct, amount, spent }) => {
        const is100 = pct >= 100;
        const pctColor = is100 ? '#dc2626' : '#d97706';
        return `
        <tr>
            <td style="padding:12px 16px;border-bottom:1px solid #e5e7eb;color:#1a1a2e;font-weight:600;">${budgetName}</td>
            <td style="padding:12px 16px;border-bottom:1px solid #e5e7eb;text-align:right;"><span style="font-weight:700;color:${pctColor};animation:pulse 1.5s ease-in-out infinite;">${Math.round(pct)}%</span></td>
            <td style="padding:12px 16px;border-bottom:1px solid #e5e7eb;text-align:right;color:#4b5563;">${formatMoney(spent)} / ${formatMoney(amount)}</td>
        </tr>`;
    }).join('');
    return `
    <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:560px;margin:0 auto;padding:40px 20px;">
        <style>@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}.anim{animation:fadeIn 0.4s ease-out;}@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.85}}</style>
        <div class="anim" style="text-align:center;margin-bottom:30px;">
            <div style="width:56px;height:56px;background:linear-gradient(135deg,#6366f1,#06b6d4);border-radius:16px;display:inline-flex;align-items:center;justify-content:center;color:#fff;font-size:24px;font-weight:bold;">F</div>
            <h1 style="color:#1a1a2e;margin:12px 0 4px;font-size:22px;">Budget alert — one or more budgets have exceeded 90%</h1>
            <p style="color:#6b7280;margin:0;font-size:14px;">The following budgets have crossed the threshold.</p>
        </div>
        <div class="anim" style="background:#fff;border-radius:12px;padding:0;margin-bottom:24px;box-shadow:0 2px 8px rgba(0,0,0,0.06);border:1px solid #e5e7eb;overflow:hidden;">
            <table style="width:100%;border-collapse:collapse;">
                <thead>
                    <tr style="background:linear-gradient(135deg,#f8f9fa,#f1f5f9);">
                        <th style="padding:12px 16px;text-align:left;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Budget</th>
                        <th style="padding:12px 16px;text-align:right;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Usage</th>
                        <th style="padding:12px 16px;text-align:right;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Spent / Amount</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
        <p style="color:#9ca3af;font-size:12px;text-align:center;">View your Budget page in Finly to adjust or track spending.</p>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;"/>
        <p style="color:#d1d5db;font-size:11px;text-align:center;">© Finly — Your Personal Finance Companion</p>
    </div>`;
}

export async function sendBudgetAlertConsolidated(email, items) {
    try {
        const subject = `Finly — Budget alert: ${items.length} budget${items.length > 1 ? 's' : ''} exceeded`;
        await sendEmail(email, subject, budgetAlertConsolidatedEmailHTML(items));
        console.log(`📧 Consolidated budget alert sent to ${email} (${items.length} budget(s))`);
    } catch (err) {
        console.error('Consolidated budget alert email error:', err);
    }
}
