const API_BASE = '';
let currentOrderId = null;

// ==========================================
// 1. Cursor Spotlight Tracking
// ==========================================
const glow = document.getElementById('cursor-glow');
document.addEventListener('mousemove', (e) => {
    glow.style.left = e.clientX + 'px';
    glow.style.top = e.clientY + 'px';
});

// ==========================================
// 2. 3D Tilt Card Physics
// ==========================================
const tiltCards = document.querySelectorAll('.tilt-card');
tiltCards.forEach(card => {
    card.addEventListener('mousemove', (e) => {
        const rect = card.getBoundingClientRect();
        const x = e.clientX - rect.left; // x position within the element.
        const y = e.clientY - rect.top;  // y position within the element.
        
        const centerX = rect.width / 2;
        const centerY = rect.height / 2;
        
        // Calculate tilt amounts (max 10 degrees)
        const tiltX = ((y - centerY) / centerY) * -10;
        const tiltY = ((x - centerX) / centerX) * 10;
        
        card.style.transform = `perspective(1000px) rotateX(${tiltX}deg) rotateY(${tiltY}deg) scale3d(1.02, 1.02, 1.02)`;
    });
    
    card.addEventListener('mouseleave', () => {
        card.style.transform = `perspective(1000px) rotateX(0deg) rotateY(0deg) scale3d(1, 1, 1)`;
    });
});

// ==========================================
// 3. Hacker Scramble Text Effect
// ==========================================
const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789₹%";
function scrambleText(element, finalValue, duration = 800) {
    let iteration = 0;
    const finalString = String(finalValue);
    const maxIterations = duration / 30; // 30ms per frame
    
    clearInterval(element.scrambleInterval);
    
    element.scrambleInterval = setInterval(() => {
        element.innerText = finalString
            .split("")
            .map((letter, index) => {
                if(index < iteration) {
                    return finalString[index];
                }
                return letters[Math.floor(Math.random() * 38)];
            })
            .join("");
            
        if(iteration >= finalString.length) { 
            clearInterval(element.scrambleInterval);
            element.innerText = finalValue;
        }
        
        iteration += finalString.length / maxIterations;
    }, 30);
}

// ==========================================
// 4. API & Metrics Logic
// ==========================================

// Fetch and populate abandoned orders dropdown
async function fetchAbandonedOrders() {
    try {
        const res = await fetch(`${API_BASE}/abandoned-orders`);
        if (!res.ok) return;
        const orders = await res.json();
        
        const select = document.getElementById('order-select');
        // Keep the first disabled option
        select.innerHTML = '<option value="" disabled selected class="bg-rzp-surface">Select an abandoned order...</option>';
        
        orders.forEach(order => {
            const option = document.createElement('option');
            option.value = order.id;
            option.className = 'bg-rzp-surface';
            option.textContent = `ORD_${order.id.substring(0,6).toUpperCase()} - ₹${order.cart_value} - ${order.status.toUpperCase()}`;
            select.appendChild(option);
        });
    } catch (e) {
        console.error("Failed to fetch abandoned orders", e);
    }
}
// Call on load
fetchAbandonedOrders();

document.getElementById('order-select').addEventListener('change', (e) => {
    currentOrderId = e.target.value;
});

function timeAgo(dateString) {
    const seconds = Math.floor((new Date() - new Date(dateString)) / 1000);
    if (seconds < 60) return 'Just now';
    if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
    return Math.floor(seconds / 3600) + 'h ago';
}

// SVG Progress Ring logic
function setProgress(id, percentage) {
    const circle = document.getElementById(id);
    if (!circle) return;
    const radius = circle.r.baseVal.value;
    const circumference = radius * 2 * Math.PI;
    const offset = circumference - (percentage / 100) * circumference;
    circle.style.strokeDashoffset = offset;
}

document.getElementById('simulate-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('sim-btn');
    const originalContent = btn.innerHTML;
    
    btn.innerHTML = `<svg class="w-6 h-6 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg><span class="text-lg relative z-10 tracking-wide ml-3">Injecting...</span>`;
    btn.disabled = true;
    
    const amount = document.getElementById('sim-amount').value;
    const reason = document.getElementById('sim-reason').value;

    try {
        const res = await fetch(`${API_BASE}/simulate-abandonment`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount: parseFloat(amount), reason })
        });
        
        if (!res.ok) throw new Error('Simulation failed');
        
        const data = await res.json();
        currentOrderId = data.id;
        
        // Refresh dropdown and select the newly injected order
        await fetchAbandonedOrders();
        document.getElementById('order-select').value = currentOrderId;
        
        const statusContainer = document.getElementById('recover-status-container');
        statusContainer.classList.add('hidden');
        
        fetchMetrics();
        
    } catch (err) {
        alert("Error connecting to backend: " + err.message);
    } finally {
        btn.innerHTML = originalContent;
        btn.disabled = false;
    }
});

document.getElementById('recover-btn').addEventListener('click', async () => {
    if (!currentOrderId) return;
    
    const btn = document.getElementById('recover-btn');
    const spinner = document.getElementById('recover-spinner');
    const icon = document.getElementById('recover-icon');
    const text = document.getElementById('recover-text');
    const statusContainer = document.getElementById('recover-status-container');
    const statusText = document.getElementById('recover-status');
    
    btn.disabled = true;
    spinner.classList.remove('hidden');
    icon.classList.add('hidden');
    text.innerText = 'Analyzing Intent...';
    
    statusContainer.classList.remove('hidden');
    statusText.innerHTML = '<span class="animate-pulse">Gemini 3.6 Flash is consulting safety guardrails...</span>';

    const promptText = document.getElementById('manual-prompt').value;

    try {
        const res = await fetch(`${API_BASE}/trigger-recovery/${currentOrderId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ custom_prompt: promptText })
        });
        
        const data = await res.json();
        
        if (data.status === 'escalated') {
            statusContainer.className = 'mt-5 p-5 rounded-xl bg-rzp-danger/10 border border-rzp-danger/40 backdrop-blur-md shadow-[0_0_20px_rgba(239,68,68,0.2)]';
            statusText.innerHTML = `<div class="flex items-center gap-2 text-rzp-danger font-bold tracking-widest mb-2 text-xs uppercase"><svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg> ESCALATED TO HUMAN</div><span class="text-sm text-rzp-danger/90 font-medium">${data.reason}</span>`;
        } else if (data.status === 'skipped') {
            statusContainer.className = 'mt-5 p-5 rounded-xl bg-white/5 border border-white/10 backdrop-blur-md';
            statusText.innerText = `Skipped: ${data.message}`;
        } else {
            const isRecovered = data.status === 'recovered';
            statusContainer.className = `mt-5 p-5 rounded-xl backdrop-blur-md ${isRecovered ? 'bg-rzp-success/10 border border-rzp-success/40 shadow-[0_0_20px_rgba(16,185,129,0.15)]' : 'bg-rzp-accent/10 border border-rzp-accent/40 shadow-[0_0_20px_rgba(245,158,11,0.15)]'}`;
            
            statusText.innerHTML = `
                <div class="flex justify-between items-start mb-3">
                    <span class="text-xs font-bold uppercase tracking-widest ${isRecovered ? 'text-rzp-success' : 'text-rzp-accent'}">${data.action.replace('_', ' ')}</span>
                    <span class="text-xs font-mono font-bold px-3 py-1 rounded bg-black/50 border border-white/10 ${isRecovered ? 'text-rzp-success' : 'text-slate-400'}">${data.status.toUpperCase()}</span>
                </div>
                <p class="text-sm text-slate-200 text-left leading-relaxed font-medium">"${data.reasoning}"</p>
                ${data.discount > 0 ? `<div class="mt-3 pt-3 border-t border-white/10 text-xs font-bold text-rzp-accent text-left tracking-wide">APPLIED ${data.discount}% STRUCTURAL DISCOUNT</div>` : ''}
            `;
        }
        
        fetchMetrics();
        await fetchAbandonedOrders();
        
        // Reset selection if the order was recovered and removed from the list
        const selectElement = document.getElementById('order-select');
        const optionExists = Array.from(selectElement.options).some(opt => opt.value === currentOrderId);
        if (!optionExists) {
            selectElement.value = "";
            currentOrderId = null;
        }
        
    } catch (err) {
        statusContainer.className = 'mt-5 p-5 rounded-xl bg-rzp-danger/10 border border-rzp-danger/40 backdrop-blur-md';
        statusText.innerText = "Execution Error: Unable to reach Gemini core.";
    } finally {
        btn.disabled = false;
        spinner.classList.add('hidden');
        icon.classList.remove('hidden');
        text.innerText = 'Run Agent Again';
    }
});

let lastRisk = -1;
let lastRecovered = -1;

async function fetchMetrics() {
    try {
        const res = await fetch(`${API_BASE}/dashboard-metrics`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.error) return;

        // Scramble animation for numbers if changed
        if (lastRisk !== data.revenue_at_risk) {
            scrambleText(document.getElementById('metric-risk'), (data.revenue_at_risk || 0).toLocaleString('en-IN'), 800);
            lastRisk = data.revenue_at_risk;
        }
        document.getElementById('metric-abandoned-count').innerText = data.total_abandoned || 0;
        
        if (lastRecovered !== data.revenue_recovered) {
            scrambleText(document.getElementById('metric-recovered'), (data.revenue_recovered || 0).toLocaleString('en-IN'), 800);
            lastRecovered = data.revenue_recovered;
        }
        document.getElementById('metric-recovered-count').innerText = data.total_recovered || 0;
        
        // Update SVG Rings (Assume 500k is a 'full' ring for visual sake)
        setProgress('ring-risk', Math.min((data.revenue_at_risk / 100000) * 100, 100));
        setProgress('ring-recovered', Math.min((data.revenue_recovered / 100000) * 100, 100));
        
        const logContainer = document.getElementById('audit-log-container');
        if (data.recent_logs && data.recent_logs.length > 0) {
            
            const firstLogId = data.recent_logs[0].id;
            const currentTop = logContainer.firstElementChild;
            if (currentTop && currentTop.dataset.id === firstLogId) {
                return;
            }

            logContainer.innerHTML = '';
            
            data.recent_logs.forEach((log, index) => {
                const actionStyles = {
                    offer_discount: { text: 'text-rzp-success', bg: 'bg-rzp-success/10', border: 'border-l-rzp-success' },
                    send_reminder: { text: 'text-rzp-primary', bg: 'bg-rzp-primary/10', border: 'border-l-rzp-primary' },
                    escalate: { text: 'text-rzp-danger', bg: 'bg-rzp-danger/10', border: 'border-l-rzp-danger' },
                    drop: { text: 'text-slate-400', bg: 'bg-white/5', border: 'border-l-slate-500' }
                };
                
                const style = actionStyles[log.action_type] || actionStyles.drop;
                const delay = index * 0.1; 
                const discount = log.metadata?.discount_offered;
                
                const logHtml = `
                    <div data-id="${log.id}" class="glass-panel rounded-2xl p-5 border-l-[3px] ${style.border} transform transition-all duration-500 opacity-0 translate-y-4" style="animation: fadeUp 0.6s cubic-bezier(0.16, 1, 0.3, 1) ${delay}s forwards;">
                        <div class="flex justify-between items-start mb-3">
                            <div class="flex items-center gap-3">
                                <span class="text-[10px] font-bold uppercase tracking-widest ${style.text} ${style.bg} px-3 py-1.5 rounded-lg border border-white/5 shadow-inner">
                                    ${(log.action_type || '').replace('_', ' ')}
                                </span>
                                ${discount > 0 ? `<span class="text-[10px] text-rzp-accent font-extrabold bg-rzp-accent/15 border border-rzp-accent/30 px-3 py-1.5 rounded-lg shadow-[0_0_10px_rgba(245,158,11,0.2)]">-${discount}%</span>` : ''}
                            </div>
                            <span class="text-xs font-mono font-bold text-slate-500">${timeAgo(log.created_at)}</span>
                        </div>
                        <p class="text-[15px] text-slate-200 leading-relaxed font-medium">"${log.reasoning}"</p>
                        <div class="mt-4 flex items-center justify-between border-t border-white/10 pt-4">
                            <span class="text-xs font-mono font-bold text-slate-500 tracking-wider">ORD_${log.order_id.substring(0,6).toUpperCase()}</span>
                            <div class="flex items-center gap-2">
                                <span class="text-xs font-mono font-bold text-white/60">₹${(log.orders?.cart_value || 0).toLocaleString('en-IN')}</span>
                                <span class="w-1.5 h-1.5 rounded-full bg-white/20"></span>
                                <span class="text-[11px] font-bold text-white/50 tracking-wide uppercase">${(log.orders?.drop_off_reason || '?').replace('_', ' ')}</span>
                            </div>
                        </div>
                    </div>
                `;
                logContainer.innerHTML += logHtml;
            });
        }
        
    } catch (e) {
        console.error("Polling error", e);
    }
}

// Start polling
setInterval(fetchMetrics, 1000);
fetchMetrics();
