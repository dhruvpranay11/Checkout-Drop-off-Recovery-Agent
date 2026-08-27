import os
import json
# pyrefly: ignore [missing-import]
from fastapi import FastAPI, HTTPException, Request
# pyrefly: ignore [missing-import]
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from supabase import create_client, Client
from google import genai
from google.genai import types
from dotenv import load_dotenv
from typing import Optional, List
from datetime import datetime
import random
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, Response
from twilio.rest import Client as TwilioClient
load_dotenv()

app = FastAPI(title="NudgePay Recovery Agent API")

# Allow CORS for frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize Supabase
SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    print("Warning: SUPABASE_URL or SUPABASE_KEY is missing.")

supabase: Client = create_client(SUPABASE_URL or "", SUPABASE_KEY or "") if SUPABASE_URL and SUPABASE_KEY else None

# Initialize Gemini
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")
if not GEMINI_API_KEY:
    print("Warning: GEMINI_API_KEY is missing.")

gemini_client = genai.Client(api_key=GEMINI_API_KEY) if GEMINI_API_KEY else None

# Initialize Twilio
TWILIO_ACCOUNT_SID = os.environ.get("TWILIO_ACCOUNT_SID")
TWILIO_AUTH_TOKEN = os.environ.get("TWILIO_AUTH_TOKEN")
TWILIO_PHONE_NUMBER = os.environ.get("TWILIO_PHONE_NUMBER")

if not TWILIO_ACCOUNT_SID or not TWILIO_AUTH_TOKEN:
    print("Warning: Twilio credentials missing. SMS will not be sent.")

twilio_client = TwilioClient(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) if TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN else None

class OrderSimulateRequest(BaseModel):
    amount: float
    reason: str

class TriggerRecoveryRequest(BaseModel):
    custom_prompt: Optional[str] = None

class RecoveryActionResponse(BaseModel):
    action: str = Field(description="The action to take: 'offer_discount', 'send_reminder', 'escalate', or 'drop'")
    discount_percentage: float = Field(description="Discount percentage if offered, 0 otherwise")
    reasoning: str = Field(description="The reasoning behind the decision")
    sms_message: str = Field(description="The exact text message to send to the customer")

@app.api_route("/twiml", methods=["GET", "POST"])
async def serve_twiml(request: Request):
    """Twilio Webhook Endpoint to serve raw TwiML for phone calls"""
    # Extract message from query params safely to avoid FastAPI 422 validation errors on Twilio's POST body
    message = request.query_params.get("message", "Hello! This is the NudgePay AI. We noticed you left your checkout, please return to complete your order.")
    
    # Sanitize XML characters just in case
    safe_msg = message.replace('<', '').replace('>', '').replace('&', 'and')
    
    # Standard Twilio XML response
    twiml = f"<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Response><Say voice='alice'>{safe_msg}</Say></Response>"
    return Response(content=twiml, media_type="text/xml")

@app.post("/simulate-abandonment")
async def simulate_abandonment(req: OrderSimulateRequest):
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")
    
    response = supabase.table('orders').insert({
        'customer_name': 'Test User',
        'customer_phone': '+918886330011',
        'cart_value': req.amount,
        'status': 'abandoned',
        'contact_attempts': 0,
        'drop_off_reason': req.reason
    }).execute()
    
    if response.data:
        return response.data[0]
    raise HTTPException(status_code=500, detail="Failed to simulate abandonment")

@app.post("/trigger-recovery/{order_id}")
async def trigger_recovery(order_id: str, req: Optional[TriggerRecoveryRequest] = None):
    if not supabase or not gemini_client:
        raise HTTPException(status_code=500, detail="Supabase or Gemini not configured")
        
    # Fetch order
    order_res = supabase.table('orders').select('*').eq('id', order_id).execute()
    if not order_res.data:
        raise HTTPException(status_code=404, detail="Order not found")
        
    order = order_res.data[0]
    
    # Check if already recovered or escalated
    if order['status'] in ['recovered', 'escalated']:
        return {"status": "skipped", "message": f"Order already {order['status']}"}
        
    # Hard Guardrails
    if order['cart_value'] > 50000:
        supabase.table('orders').update({'status': 'escalated'}).eq('id', order_id).execute()
        supabase.table('audit_logs').insert({
            'order_id': order_id,
            'action_type': 'escalate',
            'metadata': {'discount_offered': 0},
            'reasoning': 'Hard Guardrail: Order value > ₹50,000. Escalating to human agent.'
        }).execute()
        return {"status": "escalated", "reason": "Amount > 50000"}

    if order['contact_attempts'] >= 3:
        supabase.table('orders').update({'status': 'escalated'}).eq('id', order_id).execute()
        supabase.table('audit_logs').insert({
            'order_id': order_id,
            'action_type': 'escalate',
            'metadata': {'discount_offered': 0},
            'reasoning': 'Hard Guardrail: Max 3 attempts reached. Escalating.'
        }).execute()
        return {"status": "escalated", "reason": "Max attempts reached"}

    # Ask Gemini for strategy
    custom_instructions = f"\n    Additional Manual Instructions from User: {req.custom_prompt}" if req and req.custom_prompt else ""
    prompt = f"""
    You are an AI recovery agent for an e-commerce checkout.
    An order was abandoned.
    Order details:
    - Amount: ₹{order['cart_value']}
    - Drop-off Reason: {order['drop_off_reason']}
    - Previous Attempts: {order['contact_attempts']}
    
    Decide on the best recovery action AND draft the exact spoken script for an automated phone call.
    Options for action: 'offer_discount', 'send_reminder', 'escalate', 'drop'.
    Important rules:
    - If price hesitation, offer a discount (Max 10%). Mention the discount in the script.
    - If UPI timeout, send a reminder first.
    - If card decline, send a reminder to try another method.
    - Keep the script short (under 30 seconds to speak), extremely friendly, and conversational. Do NOT include any URLs or links because this will be spoken out loud by an AI voice.{custom_instructions}
    """
    
    try:
        response = None
        last_error = None
        
        # To bypass strict 20/min quotas, we will cascade through multiple valid Flash models
        models_to_try = ['gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3.5-flash', 'gemini-flash-latest']
        
        for model_name in models_to_try:
            try:
                response = gemini_client.models.generate_content(
                    model=model_name,
                    contents=prompt,
                    config=types.GenerateContentConfig(
                        response_mime_type="application/json",
                        response_schema=RecoveryActionResponse,
                    ),
                )
                break # Success! Break out of the loop
            except Exception as e:
                print(f"Model {model_name} failed: {e}")
                last_error = e
                # If we hit a rate limit, just try the next available model
                continue
                
        if not response:
            if '429' in str(last_error) or 'quota' in str(last_error).lower():
                raise HTTPException(status_code=429, detail="NudgePay System Error: Free Tier Quota Exhausted across all AI models. Please wait a few minutes.")
            raise Exception(f"Failed after trying all models. Last error: {last_error}")
        
        # Parse response safely in case of markdown wrappers
        raw_text = response.text.strip()
        if raw_text.startswith("```json"):
            raw_text = raw_text[7:]
        elif raw_text.startswith("```"):
            raw_text = raw_text[3:]
        if raw_text.endswith("```"):
            raw_text = raw_text[:-3]
            
        decision_dict = json.loads(raw_text.strip())
        decision = RecoveryActionResponse(**decision_dict)
        
        # Enforce discount cap
        final_discount = min(decision.discount_percentage, 10.0)
        
        # Update attempts
        new_attempts = order['contact_attempts'] + 1
        
        # Record audit log
        supabase.table('audit_logs').insert({
            'order_id': order_id,
            'action_type': decision.action,
            'metadata': {'discount_offered': final_discount, 'sms_draft': decision.sms_message},
            'reasoning': decision.reasoning
        }).execute()
        
        # Dispatch Phone Call via Twilio if applicable
        if decision.action in ['offer_discount', 'send_reminder'] and twilio_client:
            try:
                import urllib.parse
                
                # We hit our own FastAPI server instead of the unreliable twimlets.com
                encoded_msg = urllib.parse.quote(decision.sms_message)
                render_url = f"https://checkout-drop-off-recovery-agent.onrender.com/twiml?message={encoded_msg}"
                
                call = twilio_client.calls.create(
                    url=render_url,
                    from_=TWILIO_PHONE_NUMBER,
                    to=order['customer_phone']
                )
                print(f"Twilio Call initiated! SID: {call.sid}")
            except Exception as twilio_err:
                print(f"Failed to initiate Twilio Call: {twilio_err}")
        
        # We simulate recovery success randomly for this demo (35% success rate)
        # In real life, this would wait for user action
        success = random.random() < 0.35
        
        if success:
             supabase.table('orders').update({'status': 'recovered', 'contact_attempts': new_attempts}).eq('id', order_id).execute()
             
             # Log successful recovery in audit_logs
             supabase.table('audit_logs').insert({
                 'order_id': order_id,
                 'action_type': 'RECOVERY_SUCCESSFUL',
                 'metadata': {'recovered_amount': order['cart_value'], 'attempts_used': new_attempts},
                 'reasoning': f"Customer completed checkout via recovery link. ₹{order['cart_value']} successfully recovered."
             }).execute()
             
             result_status = "recovered"
        else:
             supabase.table('orders').update({'contact_attempts': new_attempts}).eq('id', order_id).execute()
             result_status = "abandoned"

        return {
            "status": result_status,
            "action": decision.action,
            "discount": final_discount,
            "reasoning": decision.reasoning
        }
        
    except Exception as e:
        print(f"Error calling Gemini or DB: {e}")
        raise HTTPException(status_code=500, detail=str(e)) from e

@app.get("/abandoned-orders")
async def get_abandoned_orders():
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")
    res = supabase.table('orders').select('*').in_('status', ['abandoned', 'escalated']).order('created_at', desc=True).execute()
    return res.data

@app.get("/dashboard-metrics")
async def dashboard_metrics():
    if not supabase:
        return {"error": "Supabase not configured"}
        
    # Get all orders
    orders_res = supabase.table('orders').select('*').execute()
    orders = orders_res.data
    
    revenue_at_risk = sum(o['cart_value'] for o in orders if o['status'] == 'abandoned')
    revenue_recovered = sum(o['cart_value'] for o in orders if o['status'] == 'recovered')
    
    # Get latest audit logs
    logs_res = supabase.table('audit_logs').select('*, orders(cart_value, drop_off_reason)').order('created_at', desc=True).limit(10).execute()
    logs = logs_res.data
    
    return {
        "revenue_at_risk": revenue_at_risk,
        "revenue_recovered": revenue_recovered,
        "total_abandoned": len([o for o in orders if o['status'] == 'abandoned']),
        "total_recovered": len([o for o in orders if o['status'] == 'recovered']),
        "total_escalated": len([o for o in orders if o['status'] == 'escalated']),
        "recent_logs": logs
    }

# Serve static files (frontend)
import os
frontend_path = os.path.join(os.path.dirname(__file__), "../frontend")
app.mount("/", StaticFiles(directory=frontend_path, html=True), name="static")
