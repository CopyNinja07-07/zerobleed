# smoke_test.py: checks the Data (Zetaris) and Power (Nightshift) layers
# Install once:  pip install python-dotenv requests openai
import os
import uuid

import requests
from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()
results = []


def check(name, fn):
    try:
        detail = fn() or ""
        results.append(("PASS", name, detail))
    except Exception as error:
        results.append(("FAIL", name, str(error)[:150]))


def need(*names):
    for name in names:
        assert os.environ.get(name), f"{name} is missing from .env"


def zetaris_web():
    url = os.environ.get("ZETARIS_BASE_URL", "http://localhost:3000")
    requests.get(url, timeout=10).raise_for_status()


def zetaris_sql():
    need("ZETARIS_REST_URL", "ZETARIS_ORG_ID", "ZETARIS_API_KEY")
    response = requests.post(
        os.environ["ZETARIS_REST_URL"].rstrip("/") + "/sql-editor/sqls/run",
        headers={
            "Authorization": "Bearer " + os.environ["ZETARIS_API_KEY"],
            "X-Org-ID": os.environ["ZETARIS_ORG_ID"],
            "X-Request-ID": str(uuid.uuid4()),
        },
        json={"queryId": str(uuid.uuid4()), "sql": "SELECT 1", "source": "SqlEditor", "limit": 1},
        timeout=60,
    )
    response.raise_for_status()
    data = response.json().get("data")
    assert data and str(data[0][0]) == "1", "unexpected reply: " + response.text[:80]


def nightshift_chat(model_var):
    def run():
        need("METERLESS_BASE_URL", "METERLESS_RUNTIME_TOKEN", model_var)
        client = OpenAI(
            base_url=os.environ["METERLESS_BASE_URL"],
            api_key=os.environ["METERLESS_RUNTIME_TOKEN"],
            default_headers={"meterless-app": "zerobleed", "meterless-scope": "user"},
        )
        reply = client.chat.completions.create(
            model=os.environ[model_var],
            messages=[{"role": "user", "content": "Reply with exactly: ZeroBleed online"}],
            max_tokens=300,
        )
        assert reply.choices[0].message.content, "empty reply"
        return reply.model
    return run


check("Data: Zetaris web interface", zetaris_web)
check("Data: Zetaris runs SQL over its REST API", zetaris_sql)
check("Power: Nightshift fast model answers", nightshift_chat("METERLESS_MODEL"))
check("Power: Nightshift deep model answers", nightshift_chat("METERLESS_DEEP_MODEL"))

for status, name, detail in results:
    print(f"{status}  {name}  {detail}")
