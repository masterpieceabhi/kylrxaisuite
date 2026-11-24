# Toll-free text verification: answers for the Twilio form

US carriers block business texts from unverified numbers (Twilio error 30034 for local numbers, 30032 for toll-free).
Onn HR sends sign-in codes only, so a verified toll-free number is the simplest route. Free to submit; review usually
takes a few days to three weeks.

## Steps (you, in console.twilio.com)
1. **Upgrade** the account (Admin > Account billing > Upgrade). The trial credit carries over.
2. **Buy a toll-free number**: Phone Numbers > Buy a number > tick *Toll-free* > SMS capable. About $2.15 a month.
3. **Submit verification**: Phone Numbers > Regulatory compliance > Toll-free verifications > Create, with the answers
   below.
4. When it shows **Approved**, on staging: replace `TWILIO_FROM` in `/etc/onnhr/onnhr.env` with the new number
   (same three commands as before), then `sudo systemctl restart onnhr`.
5. Keep or release +1 762 240 3385: keep it only if it becomes the WhatsApp sender later.

## Answers
| Field | Answer |
|---|---|
| Business name | Prompt AI Ethical Solutions USA LLC |
| Business website | https://onnhr.com |
| Business address | 5096 W Berkshire Dr, Franklin, WI 53132, United States |
| Business type | Private for-profit (LLC) |
| Business registration number | The company EIN [YOU] |
| Contact | Jay Patel, jay@promptaiusa.com, the company phone [YOU] |
| Estimated monthly volume | 1,000 (choose the lowest band that covers it) |
| Use case category | Two-Factor Authentication (2FA) / One-time passcodes |
| Opt-in type | Web Form |
| Opt-in image or URL | https://onnhr.com/sms (also attach a screenshot of My details showing the mobile box and its notice, and of the sign-in page under "Text it to me") |

**Use case summary**

> Onn HR (onnhr.com) is HR and time-clock software used by small US businesses for their own employees. We send
> one-time sign-in codes by text only when an employee who has added their own mobile number in the app's My details
> page asks for a code on the sign-in page. No marketing or promotional messages are sent. Each message contains a
> 6-digit code valid for 10 minutes and an optional one-tap sign-in link to app.onnhr.com. Employees can always choose
> email instead; texts are never required.

**Opt-in description**

> Employees opt in inside the signed-in Onn HR app: in My details they add their own mobile number next to the notice
> "By adding it, you agree to get Onn HR sign-in codes by text when you ask for one. Msg & data rates may apply. Reply
> STOP to opt out, HELP for help." A code is then sent only when they press "Text it to me" on the sign-in page, which
> repeats the notice and links to https://onnhr.com/sms. The privacy page https://onnhr.com/privacy states that mobile
> numbers and text-message consent are not shared or sold for marketing.

**Sample message**

> 482913 is your Onn HR sign-in code. It works for 10 minutes. Or tap to sign in: https://app.onnhr.com/login.html#k=AbC123 If you did not ask for it, ignore this message. Reply STOP to opt out.

**Additional information**

> Message frequency depends on user requests, typically a few per user per month. STOP, START and HELP are handled by
> Twilio's standard opt-out. Help: support@promptaiusa.com.
