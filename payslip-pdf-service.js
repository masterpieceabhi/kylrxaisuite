import { storage } from "./firebase-config.js";
import { companyName, escapeHtml } from "./company-name.js";
import { ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-storage.js";

let pdfLibsPromise = null;

async function loadPdfLibs() {
    if (!pdfLibsPromise) {
        pdfLibsPromise = Promise.all([
            import("https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/+esm"),
            import("https://cdn.jsdelivr.net/npm/jspdf@2.5.2/+esm")
        ]);
    }
    const [{ default: html2canvas }, { jsPDF }] = await pdfLibsPromise;
    return { html2canvas, jsPDF };
}

export function normalizePayslipEmployee(employee, data = {}) {
    const merged = { ...data, ...employee };
    const basic = parseFloat(merged.basic ?? merged.basicSalary ?? merged.breakdown?.basic ?? merged.salary ?? merged.grossSalary ?? 0);
    const incentives = parseFloat(merged.incentives ?? 0) +
        parseFloat(merged.breakdown?.hra ?? 0) +
        parseFloat(merged.breakdown?.variable ?? 0);
    const pf = basic * 0.12;
    const esic = basic > 21000 ? 0 : basic * 0.0075;
    const deductions = merged.deductions != null
        ? parseFloat(merged.deductions)
        : Math.round(pf + esic + parseFloat(merged.tds ?? merged.breakdown?.tax ?? 0));
    const net = merged.net != null ? parseFloat(merged.net) : Math.round(basic + incentives - deductions);

    return {
        id: merged.id || merged.employeeId || "",
        name: merged.name || merged.employeeName || merged.email || "Employee",
        email: merged.email || "",
        employeeCode: merged.employeeCode || (merged.id ? merged.id.substring(0, 8).toUpperCase() : "EMP"),
        department: merged.department || merged.designation || "General",
        basic: Math.round(basic),
        incentives: Math.round(incentives),
        deductions: Math.round(deductions),
        net: Math.round(net)
    };
}

export function parsePeriod(period) {
    if (!period) {
        const now = new Date();
        return { label: now.toLocaleString("default", { month: "long", year: "numeric" }), key: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}` };
    }
    const parts = String(period).trim().split(/\s+/);
    const monthNames = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
    const monthIdx = monthNames.indexOf((parts[0] || "").toLowerCase());
    const year = parts[1] || new Date().getFullYear();
    const monthNum = monthIdx >= 0 ? monthIdx + 1 : new Date().getMonth() + 1;
    const label = monthIdx >= 0 ? `${parts[0]} ${year}` : period;
    return { label, key: `${year}-${String(monthNum).padStart(2, "0")}` };
}

export function buildPayslipHtml(employee, period, company = '') {
    const e = normalizePayslipEmployee(employee);
    const { label } = parsePeriod(period);
    const pf = Math.round(e.basic * 0.12);
    const otherDed = Math.max(0, e.deductions - pf);

    return `<div style="font-family:Arial,sans-serif;width:700px;padding:24px;background:#fff;color:#0f172a;">
        <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #3b82f6;padding-bottom:12px;margin-bottom:16px;">
            <div>
                <div style="font-size:1.1rem;font-weight:800;">${escapeHtml(company) || 'Pay slip'}</div>
                <div style="font-size:0.8rem;color:#64748b;">Pay Slip for ${label}</div>
            </div>
            <div style="text-align:right;font-size:0.8rem;color:#64748b;">
                <div>Employee Code: <strong>${e.employeeCode}</strong></div>
                <div>Dept: <strong>${e.department}</strong></div>
            </div>
        </div>
        <p style="font-size:0.9rem;font-weight:700;margin-bottom:12px;">${e.name}</p>
        <table style="width:100%;border-collapse:collapse;font-size:0.85rem;">
            <tr>
                <th style="background:#f8fafc;padding:8px 12px;text-align:left;border:1px solid #e2e8f0;">Earnings</th>
                <th style="background:#f8fafc;padding:8px 12px;text-align:left;border:1px solid #e2e8f0;">Amount</th>
                <th style="background:#f8fafc;padding:8px 12px;text-align:left;border:1px solid #e2e8f0;">Deductions</th>
                <th style="background:#f8fafc;padding:8px 12px;text-align:left;border:1px solid #e2e8f0;">Amount</th>
            </tr>
            <tr>
                <td style="padding:8px 12px;border:1px solid #e2e8f0;">Basic Salary</td>
                <td style="padding:8px 12px;border:1px solid #e2e8f0;">&#8377;${e.basic.toLocaleString("en-IN")}</td>
                <td style="padding:8px 12px;border:1px solid #e2e8f0;">PF (12%)</td>
                <td style="padding:8px 12px;border:1px solid #e2e8f0;">&#8377;${pf.toLocaleString("en-IN")}</td>
            </tr>
            <tr>
                <td style="padding:8px 12px;border:1px solid #e2e8f0;">Incentives / Allowances</td>
                <td style="padding:8px 12px;border:1px solid #e2e8f0;">&#8377;${e.incentives.toLocaleString("en-IN")}</td>
                <td style="padding:8px 12px;border:1px solid #e2e8f0;">ESIC / TDS</td>
                <td style="padding:8px 12px;border:1px solid #e2e8f0;">&#8377;${otherDed.toLocaleString("en-IN")}</td>
            </tr>
            <tr>
                <td style="padding:8px 12px;border:1px solid #e2e8f0;"><strong>Gross</strong></td>
                <td style="padding:8px 12px;border:1px solid #e2e8f0;"><strong>&#8377;${(e.basic + e.incentives).toLocaleString("en-IN")}</strong></td>
                <td style="padding:8px 12px;border:1px solid #e2e8f0;"><strong>Total Deductions</strong></td>
                <td style="padding:8px 12px;border:1px solid #e2e8f0;"><strong>&#8377;${e.deductions.toLocaleString("en-IN")}</strong></td>
            </tr>
            <tr style="background:#eff6ff;">
                <td colspan="3" style="padding:8px 12px;border:1px solid #e2e8f0;font-weight:800;color:#1e40af;"><strong>Net Pay (Take Home)</strong></td>
                <td style="padding:8px 12px;border:1px solid #e2e8f0;font-weight:800;color:#1e40af;"><strong>&#8377;${e.net.toLocaleString("en-IN")}</strong></td>
            </tr>
        </table>
        <p style="font-size:0.7rem;color:#94a3b8;margin-top:12px;">Computer-generated pay slip. Confidential.</p>
    </div>`;
}

export async function generatePayslipPdfBlob(employee, period) {
    const { html2canvas, jsPDF } = await loadPdfLibs();
    const container = document.createElement("div");
    container.style.position = "fixed";
    container.style.left = "-9999px";
    container.style.top = "0";
    container.innerHTML = buildPayslipHtml(employee, period, await companyName());
    document.body.appendChild(container);

    try {
        const canvas = await html2canvas(container.firstElementChild, {
            scale: 2,
            useCORS: true,
            backgroundColor: "#ffffff",
            scrollX: 0,
            scrollY: 0
        });
        const imgData = canvas.toDataURL("image/png");
        const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
        const pageWidth = pdf.internal.pageSize.getWidth();
        const pageHeight = pdf.internal.pageSize.getHeight();
        const imgWidth = pageWidth - 20;
        const imgHeight = (canvas.height * imgWidth) / canvas.width;
        pdf.addImage(imgData, "PNG", 10, 10, imgWidth, Math.min(imgHeight, pageHeight - 20));
        return pdf.output("blob");
    } finally {
        document.body.removeChild(container);
    }
}

export async function uploadPayslipPdf(employeeId, period, blob) {
    const { key } = parsePeriod(period);
    const storagePath = `payroll/payslips/${employeeId}/${key}.pdf`;
    const storageRef = ref(storage, storagePath);
    await uploadBytes(storageRef, blob, { contentType: "application/pdf" });
    const storageUrl = await getDownloadURL(storageRef);
    return { storageUrl, storagePath, fileName: `payslip_${key}.pdf` };
}

export function downloadPayslipPdf(blob, filename) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename || "payslip.pdf";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function getApiBase() {
    const host = window.location.hostname;
    if (host === "localhost" || host === "127.0.0.1") {
        return typeof API_BASE !== 'undefined' ? API_BASE : (typeof window !== 'undefined' && window.API_BASE ? window.API_BASE : (typeof window !== 'undefined' && window.location ? window.location.origin : ''));
    }
    return "";
}

export async function fetchSignedPayslipUrl(docId, employeeId) {
    const res = await fetch(
        `${getApiBase()}/api/payroll/documents/${encodeURIComponent(docId)}/download-url?employeeId=${encodeURIComponent(employeeId)}`
    );
    const data = await res.json();
    if (!data.success) throw new Error(data.error || "Signed URL request failed");
    return data.url;
}

export async function downloadPayslipFromDoc(docData) {
    const openUrl = (url) => window.open(url, "_blank");

    if (docData.id && docData.employeeId) {
        try {
            const signed = await fetchSignedPayslipUrl(docData.id, docData.employeeId);
            openUrl(signed);
            return;
        } catch (apiErr) {
            console.warn("[PAYSLIP] Signed URL fallback:", apiErr.message);
        }
    }

    if (docData.storageUrl) {
        openUrl(docData.storageUrl);
        return;
    }
    if (docData.storagePath) {
        try {
            const storageRef = ref(storage, docData.storagePath);
            const url = await getDownloadURL(storageRef);
            openUrl(url);
            return;
        } catch (storageErr) {
            console.warn("[PAYSLIP] Storage download failed:", storageErr.message);
        }
    }
    const blob = await generatePayslipPdfBlob(
        { id: docData.employeeId, name: docData.employeeName, ...docData },
        docData.period
    );
    downloadPayslipPdf(blob, docData.fileName || "payslip.pdf");
}
