import markdown
import fitz
import re
from bs4 import BeautifulSoup
import os
from pathlib import Path
from langchain_text_splitters import RecursiveCharacterTextSplitter

def extract_text_from_markdown(path:str):
    with open(path, "r", encoding="utf-8") as f:
        content_md = f.read()
    
    html = markdown.markdown(content_md)
    
    soup = BeautifulSoup(html, "html.parser")
    cleaned_text = soup.get_text()
    
    return cleaned_text

def extract_text_from_pdf(path:str):
    doc = fitz.open(path)
    full_text = []

    for page in doc:
        full_text.append(page.get_text())

    text = " ".join(full_text)

    text = re.sub(r'-\s*\n\s*', '', text)
    text = re.sub(r'\s+', ' ', text)

    return text

def extract_text_from_txt(path:str):
    with open(path, "r", encoding="utf-8") as f:
        content_txt = f.read()

    return content_txt

mapping_function = {
    ".pdf": extract_text_from_pdf,
    ".md": extract_text_from_markdown,
    ".txt": extract_text_from_txt
}

def mapping_document(data_path:str):
    path_root = Path(data_path)
    
    file_paths = [
        str(element.resolve()) 
        for element in path_root.rglob('*') 
        if element.is_file()
    ]

    return file_paths


"""
Extract text from .pdf, .md and .txt files from a directory
"""
def prepare_docs(data_path:str):
    file_paths = mapping_document(data_path)
    files = []
    for file_path in file_paths:
        file = Path(file_path)
        extension = file.suffix
        file_name = file.name
        file = mapping_function[extension](file_path)
        files.append({"file_name": file_name, "payload": file})

    return files

def chunk_data(list_files: list[dict]):
    text_splitter = RecursiveCharacterTextSplitter(separators=["\n\n", "\n", " ", ""], chunk_size=1000, chunk_overlap=100)
    full_dataset = []
    for file in list_files:
        chunks = text_splitter.split_text(file["payload"])

        chunks_with_metadata = [{"file_name": file["file_name"], "payload": chunk, "index_chunk": idx} for idx, chunk in enumerate(chunks)]

        full_dataset = full_dataset + chunks_with_metadata

    return full_dataset



        
        