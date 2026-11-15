"""ZLens launcher: the page Snowsight's Launch app opens.

ZLens stops itself after 60 idle minutes, and a start takes about 2 to 3 minutes. Opening its
address while it is stopped or starting shows Snowflake's raw "service is not yet running" page,
and each reload asks for sign-in again. This page starts ZLens when it has stopped, waits until
Snowflake reports it READY, and only then offers Open ZLens and its address.

It reads no customer data and calls nothing outside Snowflake: only the app's own procedures
app_public.launcher_status() and app_public.launcher_start().
"""

import json
import time

import streamlit as st
from snowflake.snowpark.context import get_active_session

POLL_SECONDS = 5
TYPICAL_START_SECONDS = 180
SLOW_START_SECONDS = 300
RESEND_START_SECONDS = 30

st.set_page_config(page_title="ZLens", layout="centered")
session = get_active_session()


def read_status():
    """Service state, address and the configured ZLens user, from launcher_status()."""
    try:
        raw = session.sql("CALL app_public.launcher_status()").collect()[0][0]
        value = json.loads(raw) if isinstance(raw, str) else dict(raw or {})
    except Exception as error:  # noqa: BLE001 - shown to the person as is
        return {"status": "", "url": "", "zlens_user": "", "error": str(error)}
    return {
        "status": str(value.get("status") or "").upper(),
        "url": str(value.get("url") or ""),
        "zlens_user": str(value.get("zlens_user") or ""),
        "error": "",
    }


def start():
    try:
        session.sql("CALL app_public.launcher_start()").collect()
    except Exception:  # noqa: BLE001 - the next status read says what happened
        pass


def viewer():
    """The signed-in Snowflake user, when Streamlit can tell; empty otherwise."""
    for attribute in ("user", "experimental_user"):
        try:
            info = getattr(st, attribute)
            for key in ("user_name", "login_name"):
                name = info.get(key) if hasattr(info, "get") else None
                if name:
                    return str(name)
        except Exception:  # noqa: BLE001 - older or restricted Streamlit
            continue
    return ""


def minutes(seconds):
    seconds = int(max(0, seconds))
    return f"{seconds // 60}:{seconds % 60:02d}"


def app_name():
    try:
        return str(session.sql("SELECT CURRENT_DATABASE()").collect()[0][0])
    except Exception:  # noqa: BLE001
        return "<this app>"


state = st.session_state
status = read_status()
name = status["status"]
st.title("ZLens")

if status["error"]:
    st.error("ZLens could not read its own state: " + status["error"])
    if st.button("Try again"):
        st.rerun()
    st.stop()

# Not set up yet: the free app serves one named Snowflake user.
if not status["zlens_user"]:
    app = app_name()
    st.subheader("Set up ZLens first")
    st.write(
        "An admin names the one Snowflake user who uses ZLens, grants it one database, "
        "and grants it Cortex for Ask. Run these as a role that owns the app (replace the names):"
    )
    st.code(
        f"ALTER APPLICATION {app} SET CONFIGURATION ZLENS_USER VALUE = 'THEIR_USER';\n"
        f"GRANT USAGE ON DATABASE MY_DB TO APPLICATION {app};\n"
        f"GRANT USAGE ON SCHEMA MY_DB.MY_SCHEMA TO APPLICATION {app};\n"
        f"GRANT SELECT ON ALL TABLES IN SCHEMA MY_DB.MY_SCHEMA TO APPLICATION {app};\n"
        f"GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO APPLICATION {app};",
        language="sql",
    )
    st.caption("The app's README has the same steps. Then open this page again.")
    st.stop()

# Someone else: ZLens would refuse them after the start, so say so first.
signed_in = viewer()
if signed_in and signed_in.upper() != status["zlens_user"].upper():
    st.warning(
        f"ZLens serves {status['zlens_user']}, and you are signed in as {signed_in}. "
        "An admin can name you on the app's Configurations tab."
    )
    st.stop()

if name == "READY" and status["url"]:
    st.success("ZLens is ready")
    if "started_at" in state:
        st.caption(f"Started in {minutes(time.time() - state['started_at'])}.")
    st.link_button("Open ZLens", status["url"], type="primary")
    st.caption(
        "Opens in a new tab, where Snowflake asks you to sign in once. "
        "If your browser blocks it, copy the address:"
    )
    st.code(status["url"], language=None)
    st.caption(
        f"ZLens serves {status['zlens_user']}. You can close this tab once ZLens is open: "
        "while it stays open it keeps a small warehouse running. "
        "ZLens stops by itself after 60 idle minutes; Launch app starts it again."
    )
    st.stop()

if name in ("FAILED", "INTERNAL_ERROR"):
    st.error(
        f"ZLens did not start (Snowflake reports {name}). "
        "An admin can run CALL app_public.start_app() to try again."
    )
    if st.button("Check again"):
        st.rerun()
    st.stop()

# Stopped, stopping or starting: start it when it has stopped, then wait for READY.
now = time.time()
state.setdefault("started_at", now)
if name == "SUSPENDED" and now - state.get("start_sent_at", 0) > RESEND_START_SECONDS:
    start()
    state["start_sent_at"] = now

elapsed = now - state["started_at"]
if name == "SUSPENDING":
    st.info("ZLens is stopping after an idle hour. It starts again as soon as it has stopped.")
else:
    st.info("Starting ZLens, about 2 to 3 minutes.")
st.progress(min(elapsed / TYPICAL_START_SECONDS, 0.95))
st.caption(f"{minutes(elapsed)} so far. Your projects are kept.")
if elapsed > SLOW_START_SECONDS:
    st.warning("Still starting after 5 minutes. Keep this page open, or try again in a few minutes.")
time.sleep(POLL_SECONDS)
st.rerun()
