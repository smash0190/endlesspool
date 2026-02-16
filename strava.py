"""
Strava OAuth2 integration for uploading workouts.

Flow:
1. User provides client_id + client_secret (from https://www.strava.com/settings/api)
2. User clicks "Connect to Strava" -> redirect to Strava authorization page
3. Strava redirects back with auth code -> exchange for tokens
4. Upload TCX files via POST /api/v3/uploads
"""

import json
import os
import time
from pathlib import Path
from typing import Optional, Dict, Any

import httpx

STRAVA_AUTH_URL = "https://www.strava.com/oauth/authorize"
STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token"
STRAVA_UPLOAD_URL = "https://www.strava.com/api/v3/uploads"
STRAVA_UPLOAD_STATUS_URL = "https://www.strava.com/api/v3/uploads/{upload_id}"


def get_user_data_dir(user_id: str) -> Path:
    return Path(os.environ.get("ENDLESSPOOL_DATA_DIR", "data")) / "users" / user_id


def load_strava_tokens(user_id: str) -> Optional[Dict[str, Any]]:
    """Load stored Strava tokens for a user."""
    path = get_user_data_dir(user_id) / "strava.json"
    if not path.exists():
        return None
    with open(path) as f:
        return json.load(f)


def save_strava_tokens(user_id: str, tokens: Dict[str, Any]):
    """Save Strava tokens for a user."""
    path = get_user_data_dir(user_id) / "strava.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(tokens, f, indent=2)


def load_user_settings(user_id: str) -> Dict[str, Any]:
    """Load user settings (contains Strava client_id/client_secret)."""
    path = get_user_data_dir(user_id) / "settings.json"
    if not path.exists():
        return {}
    with open(path) as f:
        return json.load(f)


def save_user_settings(user_id: str, settings: Dict[str, Any]):
    """Save user settings."""
    path = get_user_data_dir(user_id) / "settings.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(settings, f, indent=2)


def get_auth_url(user_id: str, redirect_uri: str) -> Optional[str]:
    """
    Generate the Strava OAuth2 authorization URL.
    Returns None if client_id is not configured.
    """
    settings = load_user_settings(user_id)
    client_id = settings.get("strava_client_id")
    if not client_id:
        return None

    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": "activity:write",
        "state": user_id,
        "approval_prompt": "auto",
    }
    query = "&".join(f"{k}={v}" for k, v in params.items())
    return f"{STRAVA_AUTH_URL}?{query}"


async def exchange_token(user_id: str, code: str) -> Dict[str, Any]:
    """Exchange an authorization code for access + refresh tokens."""
    settings = load_user_settings(user_id)
    client_id = settings.get("strava_client_id")
    client_secret = settings.get("strava_client_secret")

    if not client_id or not client_secret:
        raise ValueError("Strava client_id and client_secret not configured")

    async with httpx.AsyncClient() as client:
        resp = await client.post(STRAVA_TOKEN_URL, data={
            "client_id": client_id,
            "client_secret": client_secret,
            "code": code,
            "grant_type": "authorization_code",
        })
        resp.raise_for_status()
        tokens = resp.json()

    save_strava_tokens(user_id, tokens)
    return tokens


async def refresh_token_if_needed(user_id: str) -> Optional[str]:
    """
    Get a valid access token, refreshing if expired.
    Returns the access token or None if not connected.
    """
    tokens = load_strava_tokens(user_id)
    if not tokens:
        return None

    # Check if token is expired (with 60s buffer)
    expires_at = tokens.get("expires_at", 0)
    if time.time() < expires_at - 60:
        return tokens["access_token"]

    # Refresh the token
    settings = load_user_settings(user_id)
    client_id = settings.get("strava_client_id")
    client_secret = settings.get("strava_client_secret")

    if not client_id or not client_secret:
        return None

    async with httpx.AsyncClient() as client:
        resp = await client.post(STRAVA_TOKEN_URL, data={
            "client_id": client_id,
            "client_secret": client_secret,
            "refresh_token": tokens["refresh_token"],
            "grant_type": "refresh_token",
        })
        if resp.status_code != 200:
            return None
        new_tokens = resp.json()

    # Merge new tokens (keep athlete info etc)
    tokens.update(new_tokens)
    save_strava_tokens(user_id, tokens)
    return tokens["access_token"]


async def upload_tcx(user_id: str, tcx_content: str, name: str,
                     description: str = "") -> Dict[str, Any]:
    """
    Upload a TCX file to Strava.

    Returns upload status dict with 'id', 'status', 'activity_id' etc.
    Raises on error.
    """
    access_token = await refresh_token_if_needed(user_id)
    if not access_token:
        raise ValueError("Not connected to Strava. Please connect first.")

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            STRAVA_UPLOAD_URL,
            headers={"Authorization": f"Bearer {access_token}"},
            files={"file": ("workout.tcx", tcx_content.encode(), "application/xml")},
            data={
                "data_type": "tcx",
                "name": name,
                "description": description,
            },
        )
        resp.raise_for_status()
        upload_result = resp.json()

    # Poll for completion
    upload_id = upload_result.get("id")
    if upload_id:
        for _ in range(30):  # Max 30 seconds
            await _async_sleep(1)
            status = await _check_upload_status(access_token, upload_id)
            if status.get("activity_id"):
                return status
            if status.get("error"):
                return status

    return upload_result


async def _check_upload_status(access_token: str, upload_id: int) -> Dict[str, Any]:
    """Check the status of a Strava upload."""
    url = STRAVA_UPLOAD_STATUS_URL.format(upload_id=upload_id)
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            url,
            headers={"Authorization": f"Bearer {access_token}"},
        )
        resp.raise_for_status()
        return resp.json()


async def _async_sleep(seconds: float):
    """Async sleep helper."""
    import asyncio
    await asyncio.sleep(seconds)


def is_connected(user_id: str) -> bool:
    """Check if user has Strava tokens stored."""
    tokens = load_strava_tokens(user_id)
    return tokens is not None and "access_token" in tokens
